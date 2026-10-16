// WHOOP OAuth with the user's own app (https://developer.whoop.com/docs/developing/oauth): authorization code with
// the client secret, no PKCE (WHOOP doesn't document it), `offline` for a refresh token. Refresh tokens rotate and are
// single-use, so the TokenRefresher's compare-and-swap must save each new one before it's used.

import { type RefreshFn, SourceError, type StoredTokens } from "../../broker/types.ts";
import { PATHS, type Profile, WHOOP_AUTHORIZE_URL, WHOOP_SCOPES, WHOOP_TOKEN_URL, apiGet, retryAfterMs } from "./api.ts";

/** Setup input keys holding the user's app credentials; the client record (CredentialStore.client) uses the same keys. */
export const CLIENT_ID_INPUT = "client_id";
export const CLIENT_SECRET_INPUT = "client_secret";
/** Client-record key for the WHOOP member this connection belongs to (from the profile at connect). */
export const WHOOP_USER_ID_KEY = "whoop_user_id";

/** The connection's WHOOP user id from the stored client record, as a string; null when it was never stored. */
export function whoopUserIdFrom(record: Record<string, unknown> | null | undefined): string | null {
  const v = record?.[WHOOP_USER_ID_KEY];
  return (typeof v === "number" && Number.isSafeInteger(v)) || (typeof v === "string" && /^\d{1,20}$/.test(v)) ? String(v) : null;
}

export interface WhoopClient {
  clientId: string;
  clientSecret: string;
}

/** Reads the user's app from the stored client record (`{ client_id, client_secret }`); null when incomplete. */
export function whoopClientFrom(record: Record<string, unknown> | null | undefined): WhoopClient | null {
  const clientId = record?.[CLIENT_ID_INPUT];
  const clientSecret = record?.[CLIENT_SECRET_INPUT];
  if (typeof clientId !== "string" || !clientId.trim() || typeof clientSecret !== "string" || !clientSecret) return null;
  return { clientId: clientId.trim(), clientSecret };
}

/**
 * The URL to send the user to. WHOOP requires `state` to be at least eight characters (it rejects shorter ones);
 * the caller generates and checks it (oauth_states).
 */
export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; scopes?: string[] }): string {
  if (opts.state.length < 8) throw new Error("WHOOP needs an OAuth state of at least 8 characters");
  const url = new URL(WHOOP_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", (opts.scopes ?? WHOOP_SCOPES).join(" "));
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export interface OAuthOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
}

/** What the `/oauth/connections/callback` owner passes for a WHOOP connection. */
export interface WhoopOAuthConnection {
  id: string;
  /** The redirect URI used in the authorize request (must match exactly). */
  redirectUri: string;
  /** CredentialStore.client(id): `{ client_id, client_secret }`. */
  client: Record<string, unknown> | null;
}

/**
 * Exchanges the callback's `code` for tokens and records which WHOOP member connected (the profile's user_id), so
 * webhooks from other members of the same app are dropped. The caller saves both:
 * `store.saveTokens(id, tokens)` and `store.setClient(id, client)`.
 */
export async function exchangeCode(
  code: string,
  connection: WhoopOAuthConnection,
  opts: OAuthOptions = {},
): Promise<{ tokens: StoredTokens; client: Record<string, unknown> }> {
  const client = whoopClientFrom(connection.client);
  if (!client) throw new SourceError("needs_reauth", "The WHOOP app's client ID and secret are missing: enter them again");
  const tokens = await tokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: connection.redirectUri, client_id: client.clientId, client_secret: client.clientSecret },
    opts,
  );
  if (!tokens.refreshToken) {
    throw new SourceError("protocol", "WHOOP sent no refresh token: the offline scope wasn't granted. Reconnect and approve every scope.");
  }
  const signal = opts.signal ?? AbortSignal.timeout(30_000);
  const profile = await apiGet<Profile>({ fetch: opts.fetch ?? fetch, accessToken: async () => tokens.accessToken }, PATHS.profile, {}, signal);
  if (!profile || !Number.isSafeInteger(profile.user_id)) {
    throw new SourceError("protocol", "WHOOP didn't return the member's profile: reconnect and approve every scope, including profile.");
  }
  return { tokens, client: { ...connection.client, [WHOOP_USER_ID_KEY]: profile.user_id } };
}

/** The provider exchange for TokenRefresher. Single-use refresh tokens: the response's refresh token replaces the old one. */
export function whoopRefreshFn(client: WhoopClient, opts: Omit<OAuthOptions, "signal"> = {}): RefreshFn {
  return async (current, signal) => {
    if (!current.refreshToken) throw new SourceError("needs_reauth", "WHOOP has no refresh token for this connection");
    const next = await tokenRequest(
      {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        scope: "offline",
      },
      { ...opts, signal },
    );
    return { ...next, refreshToken: next.refreshToken ?? current.refreshToken, scope: next.scope ?? current.scope };
  };
}

/**
 * Live check of a pasted client ID and secret, without a user: a token request with a dummy code. A wrong ID or
 * secret fails client authentication (`invalid_client`); right ones get past it to the code (`invalid_grant`).
 */
export async function checkClient(client: WhoopClient, redirectUri: string, opts: OAuthOptions = {}): Promise<"ok" | "invalid_client" | "unknown"> {
  try {
    await tokenRequest(
      { grant_type: "authorization_code", code: "agentinbox-client-check", redirect_uri: redirectUri, client_id: client.clientId, client_secret: client.clientSecret },
      opts,
    );
    return "ok";
  } catch (err) {
    if (err instanceof TokenEndpointError) return err.error === "invalid_client" || err.error === "unauthorized_client" ? "invalid_client" : "ok";
    return "unknown";
  }
}

const REAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

/** A token endpoint error; a SourceError so callers that don't care about `error` still get the right code. */
export class TokenEndpointError extends SourceError {
  constructor(
    readonly error: string,
    description: string,
  ) {
    super(REAUTH_ERRORS.has(error) ? "needs_reauth" : "protocol", `WHOOP refused the token request (${error})${description ? `: ${description}` : ""}`);
  }
}

async function tokenRequest(params: Record<string, string>, opts: OAuthOptions): Promise<StoredTokens> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let res: Response;
  try {
    res = await doFetch(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new SourceError("unavailable", `WHOOP is unreachable: ${(err as Error).message}`);
  }
  if (res.status === 429) {
    await res.body?.cancel();
    throw new SourceError("rate_limited", "WHOOP's rate limit was reached", retryAfterMs(res.headers));
  }
  if (res.status >= 500) {
    await res.body?.cancel();
    throw new SourceError("unavailable", `WHOOP's token endpoint answered ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body.access_token !== "string") {
    const error = typeof body?.error === "string" ? body.error : res.ok ? "invalid_response" : `http_${res.status}`;
    const description = typeof body?.error_description === "string" ? body.error_description.slice(0, 300) : "";
    throw new TokenEndpointError(error, description);
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : now() + expiresIn * 1000,
    scope: typeof body.scope === "string" ? body.scope : null,
    issuer: null,
  };
}
