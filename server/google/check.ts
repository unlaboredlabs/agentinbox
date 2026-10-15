import { randomBytes } from "node:crypto";
import type { GoogleClientCheck } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { errorMessage } from "../util/errors.ts";
import { callbackMode, clientCredentials, clientWarnings, redirectWarning } from "./client.ts";
import { buildUrl } from "./http.ts";

/**
 * Verifies the saved OAuth client against Google before anyone tries to connect, because Google shows
 * a wrong client ID or an unregistered redirect URI on its own page and never redirects back.
 *
 * This relies on undocumented behavior, so it classifies conservatively ("unknown" unless the answer is
 * unambiguous) and never blocks saving:
 * - Client ID and redirect URI: an anonymous GET of the consent URL. Google redirects a signed-out
 *   browser to its sign-in page when both are fine, and to an error page naming invalid_client /
 *   redirect_uri_mismatch otherwise. Redirects are followed only on Google's hosts.
 * - Secret: the token endpoint with a dummy authorization code. Google checks the client credentials
 *   first: invalid_client means they're wrong, invalid_grant means they're right (and the code isn't).
 * Secrets are never logged.
 */

type Ctx = Pick<AppContext, "settings" | "crypto" | "config" | "log">;
type Probe = Pick<GoogleClientCheck, "clientId" | "redirectUri">;

const TIMEOUT_MS = 5000;
const MAX_HOPS = 3;
const UNKNOWN: Probe = { clientId: "unknown", redirectUri: "unknown" };

/** Google's error pages carry the error in plain text or in a base64 `authError` parameter. */
function errorText(url: URL, body = ""): string {
  let decoded = "";
  const authError = url.searchParams.get("authError");
  if (authError) {
    try {
      decoded = Buffer.from(authError.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    } catch {
      // ignore
    }
  }
  return `${decodeURIComponent(url.search)} ${decoded} ${body}`;
}

function classifyText(text: string): Probe | null {
  if (/\b(invalid_client|deleted_client)\b|OAuth client was not found/i.test(text)) return { clientId: "invalid", redirectUri: "unknown" };
  if (/\bredirect_uri_mismatch\b/i.test(text)) return { clientId: "ok", redirectUri: "missing" };
  return null;
}

const SIGN_IN = /\/(v3\/)?signin\/(v2\/)?(identifier|challenge|oauth\/(?!error)[\w/]*|accountchooser)|\/ServiceLogin|\/AccountChooser|oauthchooseaccount/i;

async function probeAuth(ctx: Ctx, clientId: string, redirectUri: string): Promise<Probe> {
  const start = new URL(
    buildUrl(ctx.config.google.authBase, "/o/oauth2/v2/auth", {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid",
      hl: "en", // English error pages, for the text matching below
    }),
  );
  const allowed = (u: URL) => u.host === start.host || u.hostname === "google.com" || u.hostname.endsWith(".google.com");
  const redirect = new URL(redirectUri);
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/html" } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      const next = new URL(location, url);
      // Back at our own redirect URI (a browser with a session would get here): Google accepted both.
      if (next.origin === redirect.origin && next.pathname === redirect.pathname) {
        const error = next.searchParams.get("error");
        if (!error || next.searchParams.has("code")) return { clientId: "ok", redirectUri: "ok" };
        return classifyText(error) ?? UNKNOWN;
      }
      const known = classifyText(errorText(next));
      if (known) return known;
      if (!allowed(next)) return UNKNOWN;
      if (SIGN_IN.test(next.pathname)) return { clientId: "ok", redirectUri: "ok" };
      url = next;
      continue;
    }
    const body = (await res.text()).slice(0, 200_000);
    const known = classifyText(errorText(url, body));
    if (known) return known;
    if (res.ok && SIGN_IN.test(url.pathname)) return { clientId: "ok", redirectUri: "ok" };
    return UNKNOWN;
  }
  return UNKNOWN;
}

interface SecretProbe {
  secret: GoogleClientCheck["secret"];
  /** Google said the client itself doesn't exist ("The OAuth client was not found."). */
  clientNotFound: boolean;
}

async function probeSecret(ctx: Ctx, clientId: string, clientSecret: string, redirectUri: string): Promise<SecretProbe> {
  const res = await fetch(buildUrl(ctx.config.google.oauthBase, "/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: `4/0agentinbox-check-${randomBytes(12).toString("hex")}`,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { error?: unknown; error_description?: unknown } | null;
  const error = typeof body?.error === "string" ? body.error : null;
  const description = typeof body?.error_description === "string" ? body.error_description : "";
  if (error === "invalid_client") {
    // A missing client and a wrong secret share the error code; only the description tells them apart.
    if (/client was not found/i.test(description)) return { secret: "unknown", clientNotFound: true };
    return { secret: "invalid", clientNotFound: false };
  }
  // invalid_grant: the credentials passed and only our dummy code was refused. Anything else (including
  // unauthorized_client, which is about the client's configuration) says nothing certain about the secret.
  return { secret: error === "invalid_grant" ? "ok" : "unknown", clientNotFound: false };
}

/** Runs both probes, stores the result for setup warnings, and returns it. Never throws for Google's answers. */
export async function checkClient(ctx: Ctx): Promise<GoogleClientCheck> {
  const { clientId, clientSecret } = clientCredentials(ctx);
  const saved = ctx.settings.getState("google.client");
  const { redirectUri } = callbackMode(ctx);
  const log = ctx.log.child("google");
  const [auth, secret] = await Promise.all([
    probeAuth(ctx, clientId, redirectUri).catch((err: unknown) => {
      log.debug("OAuth client check (consent URL) inconclusive", { error: errorMessage(err) });
      return UNKNOWN;
    }),
    probeSecret(ctx, clientId, clientSecret, redirectUri).catch((err: unknown): SecretProbe => {
      log.debug("OAuth client check (token endpoint) inconclusive", { error: errorMessage(err) });
      return { secret: "unknown", clientNotFound: false };
    }),
  ]);
  // An unknown client ID makes the token endpoint say invalid_client too: that says nothing about the secret.
  const clientInvalid = auth.clientId === "invalid" || secret.clientNotFound;
  const result: Omit<GoogleClientCheck, "warnings"> = clientInvalid
    ? { clientId: "invalid", redirectUri: auth.redirectUri, secret: "unknown" }
    : { ...auth, secret: secret.secret };
  const current = ctx.settings.getState("google.client");
  // Store only if the client wasn't changed while we were asking Google.
  if (current && saved && current.clientId === saved.clientId && current.clientSecretEnc === saved.clientSecretEnc) {
    ctx.settings.setState("google.client", { ...current, check: { ...result, redirectUriTested: redirectUri, at: new Date().toISOString() } });
  }
  log.info("OAuth client checked", result);
  const redirect = redirectWarning(ctx);
  return { ...result, warnings: [...clientWarnings(ctx), ...(redirect ? [redirect] : [])] };
}
