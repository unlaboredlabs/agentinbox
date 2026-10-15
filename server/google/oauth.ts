import { createHash, randomBytes } from "node:crypto";
import type { Account, ConnectAccountResponse } from "../../shared/types.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { badRequest, errorMessage, HttpError } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";
import { type AccountRow, getRow, toAccount } from "./accounts.ts";
import { callbackMode, clientCredentials } from "./client.ts";
import { buildUrl, REQUEST_TIMEOUT_MS } from "./http.ts";
import { pubsubPrincipal } from "./pubsub.ts";
import { postToken, type TokenResponse } from "./tokens.ts";
import { GoogleApiError } from "./types.ts";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";
/** Every account: Gmail plus identity (for the display name). */
export const BASE_SCOPES = [GMAIL_SCOPE, "openid", "email", "profile"];
/** Optional extra scopes, requested incrementally (include_granted_scopes) only when needed. */
export const EXTRA_SCOPES = { pubsub: PUBSUB_SCOPE } as const;
export type ExtraScope = keyof typeof EXTRA_SCOPES;

const STATE_TTL_MS = 15 * 60_000;

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Human explanations for errors Google returns on the redirect or the token endpoint. */
export function oauthErrorHint(code: string): { message: string; hint: string } {
  switch (code) {
    case "access_denied":
      return {
        message: "Access was denied on Google's consent screen.",
        hint: "Click Allow and keep every permission checked. If your OAuth app is External and in Testing, add this Google account as a test user or publish the app.",
      };
    case "org_internal":
      return {
        message: "This OAuth app is Internal: only accounts in its Workspace org can connect.",
        hint: "Sign in with an account from that Workspace org, or switch the consent screen to External (In production) to allow other accounts.",
      };
    case "admin_policy_enforced":
      return {
        message: "Your Google Workspace admin blocks this app.",
        hint: "Ask the admin to trust the OAuth client ID in Admin console → Security → API controls → App access control.",
      };
    case "redirect_uri_mismatch":
      return {
        message: "Google rejected the redirect URI.",
        hint: "Add the exact redirect URI shown in the setup wizard to the OAuth client's Authorized redirect URIs.",
      };
    case "invalid_client":
    case "unauthorized_client":
      return {
        message: "Google rejected the OAuth client ID or secret.",
        hint: "Re-copy the client ID and secret from Google Cloud → Credentials into the setup wizard. The client type must be Web application.",
      };
    case "invalid_grant":
      return {
        message: "The authorization code is invalid or has expired.",
        hint: "Codes are single-use and expire quickly. Start the connection again from the console.",
      };
    default:
      return { message: `Google returned an error: ${code}.`, hint: "Start the connection again from the console." };
  }
}

const oauthError = (code: string, description?: string | null) => {
  const { message, hint } = oauthErrorHint(code);
  return new HttpError(400, `oauth_${code}`, description && !message.includes(description) ? `${message} (${description})` : message, hint);
};

/**
 * Starts a consent flow. `scopes: ["pubsub"]` adds the Pub/Sub scope for the provisioning account
 * (without `reauthAccountId` it targets the account provisioning would use).
 */
export function startConnect(ctx: AppContext, opts: { reauthAccountId?: string; scopes?: ExtraScope[] } = {}): ConnectAccountResponse {
  const { clientId } = clientCredentials(ctx);
  const extra = [...new Set(opts.scopes ?? [])];
  let reauthId = opts.reauthAccountId;
  if (!reauthId && extra.includes("pubsub")) {
    reauthId = pubsubPrincipal(ctx)?.id;
    if (!reauthId) throw badRequest("Connect a Gmail account first.", "Pub/Sub is provisioned with a connected account's permissions.");
  }
  const reauth = reauthId ? ctx.accounts.require(reauthId) : null;
  const scopes = [...BASE_SCOPES, ...extra.map((x) => EXTRA_SCOPES[x])];
  const { mode, redirectUri } = callbackMode(ctx);
  const state = randomToken(32);
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  ctx.db.run("DELETE FROM oauth_states WHERE created_at < ?", new Date(Date.now() - STATE_TTL_MS).toISOString());
  ctx.db.run(
    "INSERT INTO oauth_states (state, code_verifier, redirect_uri, reauth_account_id, created_at) VALUES (?, ?, ?, ?, ?)",
    state,
    verifier,
    redirectUri,
    reauth?.id ?? null,
    now(),
  );
  const authUrl = buildUrl(ctx.config.google.authBase, "/o/oauth2/v2/auth", {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    login_hint: reauth?.email,
  });
  return { authUrl, state, callbackMode: mode };
}

interface StateRow {
  state: string;
  code_verifier: string;
  redirect_uri: string;
  reauth_account_id: string | null;
  created_at: string;
}

/** Consumes a pending state (single use). */
function takeState(ctx: AppContext, state: string): StateRow {
  const row = state ? ctx.db.get<StateRow>("SELECT * FROM oauth_states WHERE state = ?", state) : undefined;
  if (row) ctx.db.run("DELETE FROM oauth_states WHERE state = ?", state);
  if (!row || Date.parse(row.created_at) + STATE_TTL_MS < Date.now()) {
    throw new HttpError(
      400,
      "oauth_state",
      "This sign-in link has expired or was already used.",
      "Start the connection again from the Accounts page in the console.",
    );
  }
  return row;
}

/** Decodes the id_token payload (received directly from Google over TLS, so no signature check). */
function idTokenClaims(idToken: string | undefined): { email?: string; name?: string } {
  const payload = idToken?.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string; name?: string };
  } catch {
    return {};
  }
}

async function fetchProfile(ctx: AppContext, accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const res = await fetch(buildUrl(ctx.config.google.gmailBase, "/gmail/v1/users/me/profile"), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { emailAddress?: string; historyId?: string; error?: { message?: string } } | null;
  if (!res.ok || !body?.emailAddress) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    if (/has not been used|is disabled/i.test(message)) {
      throw badRequest(
        "The Gmail API isn't enabled in your Google Cloud project.",
        "Enable it at https://console.cloud.google.com/apis/library/gmail.googleapis.com, wait a minute, then connect again.",
      );
    }
    throw new HttpError(502, "google_error", `Couldn't read the Gmail profile: ${message}`);
  }
  return { emailAddress: body.emailAddress, historyId: String(body.historyId ?? "") };
}

async function revokeToken(ctx: AppContext, token: string): Promise<void> {
  await fetch(buildUrl(ctx.config.google.oauthBase, "/revoke", { token }), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
}

const byEmail = (ctx: AppContext, email: string) =>
  ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE", email.trim());

/**
 * Discards tokens we won't keep. Revocation kills the user's whole grant for this OAuth client, so it
 * only happens when the Google account is not connected here (otherwise it would break that account).
 */
async function discardTokens(ctx: AppContext, tokens: TokenResponse, email: string | null | undefined): Promise<void> {
  if (!email || byEmail(ctx, email)) return;
  await revokeToken(ctx, tokens.refresh_token ?? tokens.access_token);
}

/** Saves fresh tokens on an existing account. needs_reauth/error become active; paused stays paused. */
function storeTokens(ctx: AppContext, row: AccountRow, tokens: TokenResponse & { refresh_token: string }, granted: string[], name?: string): void {
  ctx.db.run(
    `UPDATE accounts SET display_name = ?, status = ?, last_error = NULL, refresh_token_enc = ?, access_token_enc = ?,
       access_expires_at = ?, scopes = ? WHERE id = ?`,
    name ?? row.display_name,
    row.status === "paused" ? "paused" : "active",
    ctx.crypto.encrypt(tokens.refresh_token),
    ctx.crypto.encrypt(tokens.access_token),
    expiry(tokens),
    JSON.stringify(granted),
    row.id,
  );
}

const expiry = (t: TokenResponse) => new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString();

export async function completeConnect(ctx: AppContext, code: string, state: string): Promise<Account> {
  const st = takeState(ctx, state);
  if (!code) throw badRequest("Google didn't return an authorization code.", "Start the connection again from the console.");
  const { clientId, clientSecret } = clientCredentials(ctx);
  let tokens: TokenResponse;
  try {
    tokens = await postToken(ctx, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: st.redirect_uri,
      code_verifier: st.code_verifier,
    });
  } catch (err) {
    if (err instanceof GoogleApiError && err.reason) throw oauthError(err.reason, err.message !== err.reason ? err.message : null);
    throw err;
  }

  const claims = idTokenClaims(tokens.id_token);
  const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  if (granted.length && !granted.includes(GMAIL_SCOPE)) {
    await discardTokens(ctx, tokens, claims.email);
    throw badRequest(
      "Gmail access wasn't granted.",
      "Connect again and keep the \"Read, compose, and send emails\" permission checked on Google's consent screen.",
    );
  }
  const profile = await fetchProfile(ctx, tokens.access_token);
  const email = profile.emailAddress;
  const existing = byEmail(ctx, email);
  const scopes = granted.length ? granted : BASE_SCOPES;
  const refreshed = existing && tokens.refresh_token ? " Its saved sign-in in agentinbox was refreshed." : "";

  if (st.reauth_account_id) {
    const target = getRow(ctx, st.reauth_account_id);
    if (!target || target.email.toLowerCase() !== email.toLowerCase()) {
      // Keep the tokens if they belong to another connected account; never revoke them (that would break it).
      if (existing && tokens.refresh_token) storeTokens(ctx, existing, { ...tokens, refresh_token: tokens.refresh_token }, scopes, claims.name);
      else await discardTokens(ctx, tokens, email);
      if (!target) {
        throw badRequest(
          `The account you were reconnecting was removed from agentinbox meanwhile.${refreshed}`,
          "Use Connect account to add it again.",
        );
      }
      throw badRequest(
        `You signed in as ${email}, but this reconnect is for ${target.email}.${refreshed}`,
        `Start the reconnect again and choose ${target.email} in Google's account picker.`,
      );
    }
  }
  if (!tokens.refresh_token) {
    throw badRequest(
      "Google didn't return a refresh token, so agentinbox can't stay connected.",
      "Remove agentinbox's access at https://myaccount.google.com/permissions, then connect again.",
    );
  }

  const id = existing?.id ?? newId("acc");
  if (existing) {
    storeTokens(ctx, existing, { ...tokens, refresh_token: tokens.refresh_token }, scopes, claims.name);
  } else {
    ctx.db.run(
      `INSERT INTO accounts (id, email, display_name, status, last_error, refresh_token_enc, access_token_enc, access_expires_at, scopes, created_at)
       VALUES (?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?)`,
      id,
      email,
      claims.name ?? null,
      ctx.crypto.encrypt(tokens.refresh_token),
      ctx.crypto.encrypt(tokens.access_token),
      expiry(tokens),
      JSON.stringify(scopes),
      now(),
    );
  }
  ctx.audit.record({
    ...ADMIN_ACTOR,
    action: existing ? "account.reconnect" : "account.connect",
    accountId: id,
    outcome: "ok",
    detail: { email, scopes },
  });
  const log = ctx.log.child("google");
  log.info(existing ? "Account reconnected" : "Account connected", { email });

  try {
    await ctx.ingest.onAccountConnected(id);
  } catch (err) {
    log.warn("Post-connect setup failed", { email, error: errorMessage(err) });
    ctx.db.run("UPDATE accounts SET last_error = ? WHERE id = ?", `Connected, but initial sync setup failed: ${errorMessage(err)}`, id);
  }
  const account = toAccount(getRow(ctx, id)!);
  ctx.bus.emit("account", account);
  return account;
}

export async function completeConnectFromUrl(ctx: AppContext, raw: string): Promise<Account> {
  let url: URL;
  try {
    const text = raw.trim();
    url = new URL(text.startsWith("?") ? `http://localhost/oauth/callback${text}` : text);
  } catch {
    throw badRequest("That isn't a valid URL.", "Copy the whole address from the browser's address bar after approving access.");
  }
  const q = url.searchParams;
  const error = q.get("error");
  if (error) {
    const state = q.get("state");
    if (state) ctx.db.run("DELETE FROM oauth_states WHERE state = ?", state);
    throw oauthError(error, q.get("error_description"));
  }
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) {
    throw badRequest(
      "That URL doesn't contain an authorization code.",
      "After approving access, copy the full address you land on (it starts with http://localhost and contains ?code=…&state=…), even if the page doesn't load.",
    );
  }
  return completeConnect(ctx, code, state);
}

/** Revokes the account's refresh token at Google (best effort; errors are thrown to the caller). */
export async function revokeAccount(ctx: AppContext, accountId: string): Promise<void> {
  const row = getRow(ctx, accountId);
  if (!row) return;
  const res = await fetch(buildUrl(ctx.config.google.oauthBase, "/revoke", { token: ctx.crypto.decrypt(row.refresh_token_enc) }), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 400 invalid_token means it was already revoked.
  if (!res.ok && res.status !== 400) throw new GoogleApiError(res.status, `Token revocation failed (HTTP ${res.status})`);
}
