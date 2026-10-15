import type {
  GoogleAppType,
  GoogleClientConfig,
  GoogleClientImportInput,
  GoogleClientImportResult,
  GoogleClientView,
  SetupWarning,
} from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { badRequest, HttpError } from "../util/errors.ts";

type Ctx = Pick<AppContext, "settings" | "crypto" | "config">;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Google only accepts https or loopback redirect URIs. An https or localhost publicUrl gets a direct
 * callback; anything else (plain http on a LAN/hostname) uses "paste" mode on a localhost URI.
 */
export function callbackMode(ctx: Ctx): { mode: "direct" | "paste"; redirectUri: string } {
  const publicUrl = ctx.settings.publicUrl();
  let url: URL | null = null;
  try {
    url = new URL(publicUrl);
  } catch {
    // Settings validates publicUrl; fall through to paste mode just in case.
  }
  if (url && (url.protocol === "https:" || LOOPBACK.has(url.hostname))) {
    return { mode: "direct", redirectUri: `${publicUrl}/oauth/callback` };
  }
  return { mode: "paste", redirectUri: `http://localhost:${ctx.config.port}/oauth/callback` };
}

export function clientView(ctx: Ctx): GoogleClientView {
  const c = ctx.settings.getState("google.client");
  const { mode, redirectUri } = callbackMode(ctx);
  return {
    clientId: c?.clientId || null,
    hasSecret: Boolean(c?.clientSecretEnc),
    projectId: c?.projectId || null,
    appType: c?.appType ?? null,
    redirectUri,
    callbackMode: mode,
    secretHint: c?.clientSecretEnc ? (c.secretHint ?? secretTail(ctx, c.clientSecretEnc)) : null,
    redirectUriConfirmed: redirectConfirmed(ctx, redirectUri),
  };
}

/** Evidence that `uri` is registered on the saved client (see GoogleClientView.redirectUriConfirmed). */
function redirectConfirmed(ctx: Ctx, uri: string): boolean {
  const c = ctx.settings.getState("google.client");
  if (!c?.clientId) return false;
  if (c.verifiedRedirectUri === uri) return true;
  // Google's own answer beats the imported JSON (a snapshot), as in redirectWarning.
  const checked = c.check?.redirectUriTested === uri ? c.check.redirectUri : "unknown";
  if (checked !== "unknown") return checked === "ok";
  return !!c.importedRedirectUris?.includes(uri);
}

/**
 * After a public URL change: a client saved before savedRedirectUri existed gets `previousUri` (the
 * redirect URI in effect before the change), so the change is noticed (redirect_uri_changed).
 */
export function recordPreviousRedirect(ctx: Ctx, previousUri: string): void {
  const c = ctx.settings.getState("google.client");
  if (!c?.clientId || c.savedRedirectUri) return;
  ctx.settings.setState("google.client", { ...c, savedRedirectUri: previousUri });
}

/** Last 4 characters of a stored secret (for clients saved before secretHint was recorded). */
function secretTail(ctx: Ctx, enc: string): string | null {
  try {
    return ctx.crypto.decrypt(enc).slice(-4);
  } catch {
    return null;
  }
}

const PROJECT_ID = /^([a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Saves the OAuth client. The secret is write-only: omit it to keep the stored one. */
export function setClient(ctx: Ctx, input: GoogleClientConfig): GoogleClientView {
  return saveClient(ctx, input);
}

const CLIENT_SUFFIX = ".apps.googleusercontent.com";

function saveClient(
  ctx: Ctx,
  input: Omit<GoogleClientConfig, "appType"> & { appType: GoogleAppType | null; importedRedirectUris?: string[] },
): GoogleClientView {
  const clientId = input.clientId.trim();
  const projectId = input.projectId.trim();
  if (!clientId.endsWith(CLIENT_SUFFIX)) {
    throw badRequest(
      "That doesn't look like an OAuth client ID",
      "Copy the Client ID of your OAuth client (type Web application); it ends with .apps.googleusercontent.com.",
    );
  }
  if (projectId && !PROJECT_ID.test(projectId)) {
    throw badRequest(
      "That doesn't look like a Google Cloud project ID",
      "Use the project ID (lowercase, e.g. my-project-123) shown on the Cloud console dashboard, not the project name or number.",
    );
  }
  const prev = ctx.settings.getState("google.client");
  const secret = input.clientSecret?.trim();
  const clientSecretEnc = secret ? ctx.crypto.encrypt(secret) : prev?.clientId === clientId ? prev.clientSecretEnc : null;
  if (!clientSecretEnc) {
    throw badRequest("The client secret is required", "Copy it from the OAuth client's page in Google Cloud (Credentials).");
  }
  // What we learned about the client (its registered redirect URIs, a redirect that worked) stays
  // valid while it is the same client; manual entry keeps it, a different client ID drops it.
  const same = prev?.clientId === clientId;
  const importedRedirectUris = input.importedRedirectUris ?? (same ? prev?.importedRedirectUris : undefined);
  const secretHint = secret ? secret.slice(-4) : same ? prev?.secretHint : undefined;
  // `check` is dropped: the console API re-runs it right after saving (server/google/check.ts).
  ctx.settings.setState("google.client", {
    clientId,
    clientSecretEnc,
    projectId,
    appType: input.appType,
    ...(importedRedirectUris ? { importedRedirectUris } : {}),
    savedRedirectUri: callbackMode(ctx).redirectUri,
    verifiedRedirectUri: same ? (prev?.verifiedRedirectUri ?? null) : null,
    ...(secretHint ? { secretHint } : {}),
  });
  return clientView(ctx);
}

const importError = (code: string, message: string, hint: string) => new HttpError(400, code, message, hint);

const DOWNLOAD_HINT =
  "In Google Cloud open Google Auth Platform → Clients, open your Web application client, click Download JSON, and paste the file's whole contents.";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Imports Google's client-secret JSON (`{"web": {client_id, client_secret, project_id, redirect_uris, …}}`).
 * Saves the client whenever its ID and secret are usable; a missing redirect URI comes back as a
 * warning (and stays in setup state) rather than an error, because the JSON is only a snapshot: the
 * operator may have added the URI after downloading it.
 */
export function importClient(ctx: Ctx, input: GoogleClientImportInput): Omit<GoogleClientImportResult, "check"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json.trim());
  } catch {
    throw importError("client_json_invalid", "That isn't valid JSON.", DOWNLOAD_HINT);
  }
  const obj = isObject(parsed) ? parsed : null;
  if (obj && isObject(obj.installed)) {
    throw importError(
      "client_json_desktop",
      "This is a Desktop app client. Create a Web application client instead.",
      `In Google Cloud → Google Auth Platform → Clients → Create client, choose Application type "Web application", ` +
        `add ${callbackMode(ctx).redirectUri} under Authorized redirect URIs, create it, then download its JSON.`,
    );
  }
  const web = obj && isObject(obj.web) ? obj.web : null;
  if (!web) throw importError("client_json_invalid", 'That isn\'t a Google OAuth client file (it has no "web" section).', DOWNLOAD_HINT);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const clientId = str(web.client_id);
  if (!clientId.endsWith(CLIENT_SUFFIX)) {
    throw importError("client_json_invalid", `The file's client_id doesn't end with ${CLIENT_SUFFIX}.`, DOWNLOAD_HINT);
  }
  const secret = str(web.client_secret);
  const prev = ctx.settings.getState("google.client");
  if (!secret && !(prev?.clientId === clientId && prev.clientSecretEnc)) {
    throw importError(
      "client_secret_missing",
      "The file has no client secret.",
      "Google only puts the secret in the JSON you download right when the client is created. Open the client in Google Cloud " +
        "(Google Auth Platform → Clients → your client), click Add secret, then enter the client ID and the new secret manually.",
    );
  }
  const registered = Array.isArray(web.redirect_uris) ? web.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  const view = saveClient(ctx, {
    clientId,
    clientSecret: secret || undefined,
    projectId: str(web.project_id),
    appType: input.appType ?? prev?.appType ?? null,
    importedRedirectUris: registered,
  });
  const warning = redirectWarning(ctx);
  return { ...view, warnings: warning ? [warning] : [], registeredRedirectUris: registered };
}

const clientsUrl = (projectId: string) => `https://console.cloud.google.com/auth/clients${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`;

/**
 * `redirect_uri_missing` / `redirect_uri_changed`, from the strongest evidence available for the
 * current redirect URI: a successful connection through it (registered), else the last client check
 * (Google's own answer), else the redirect_uris in the last imported JSON, else whether the public URL
 * changed since the client was saved (it was presumably registered with the redirect URI back then).
 */
export function redirectWarning(ctx: Ctx): SetupWarning | null {
  const c = ctx.settings.getState("google.client");
  if (!c?.clientId) return null;
  const uri = callbackMode(ctx).redirectUri;
  if (c.verifiedRedirectUri === uri) return null;
  const checked = c.check?.redirectUriTested === uri ? c.check.redirectUri : "unknown";
  if (checked === "ok") return null;
  const hint =
    `In Google Cloud → Google Auth Platform → Clients → your client → Authorized redirect URIs, add ${uri} exactly (no trailing slash) and save. ` +
    "You don't need to download the JSON again (it's only used here to read the ID and secret): this warning clears as soon as an account connects, or re-check now.";
  const registered = c.importedRedirectUris;
  const listed = registered ? (registered.length ? ` It lists: ${registered.join(", ")}.` : " It lists none.") : "";
  if (checked === "missing") {
    return {
      code: "redirect_uri_missing",
      severity: "error",
      message: `Google says ${uri} isn't an Authorized redirect URI of your OAuth client, so it will refuse to connect accounts.${listed}`,
      hint,
      url: clientsUrl(c.projectId),
    };
  }
  if (registered?.includes(uri)) return null;
  if (!registered) {
    const saved = c.savedRedirectUri;
    if (!saved || saved === uri) return null;
    return {
      code: "redirect_uri_changed",
      severity: "error",
      message:
        `agentinbox's address changed, so its redirect URI is now ${uri} (it was ${saved} when you saved the OAuth client). ` +
        'Until the new one is added to the client, Google refuses to connect accounts ("Error 400: redirect_uri_mismatch").',
      hint:
        `In Google Cloud → Google Auth Platform → Clients → your client → Authorized redirect URIs, click Add URI, enter ${uri} exactly ` +
        "(no trailing slash) and save. Then click \"I've added it, check now\" (or save the client again): this warning clears once Google confirms it.",
      url: clientsUrl(c.projectId),
    };
  }
  return {
    code: "redirect_uri_missing",
    severity: "error",
    message: `Your OAuth client's Authorized redirect URIs don't include ${uri}, so Google will refuse to connect accounts.${listed}`,
    hint,
    url: clientsUrl(c.projectId),
  };
}

/** client_invalid / client_secret_invalid from the last client check. */
export function clientWarnings(ctx: Ctx): SetupWarning[] {
  const c = ctx.settings.getState("google.client");
  if (!c?.clientId || !c.check) return [];
  if (c.check.clientId === "invalid") {
    return [
      {
        code: "client_invalid",
        severity: "error",
        message: `Google doesn't recognize the OAuth client ID ${c.clientId}.`,
        hint:
          "Copy the Client ID again from Google Cloud → Google Auth Platform → Clients (or re-import the client's JSON). " +
          "If the client was deleted, create a new Web application client.",
        url: clientsUrl(c.projectId),
      },
    ];
  }
  if (c.check.secret === "invalid") {
    return [
      {
        code: "client_secret_invalid",
        severity: "error",
        message: `Google rejected the client secret${c.secretHint ? ` ending in ${c.secretHint}` : ""} for this OAuth client.`,
        hint:
          "Re-import the client JSON downloaded when the client was created, or open the client in Google Cloud → Google Auth Platform → Clients, " +
          "click Add secret, and enter the new secret here.",
        url: clientsUrl(c.projectId),
      },
    ];
  }
  return [];
}

/**
 * Records that Google accepted `redirectUri` for the saved client (an account just connected through
 * it). A successful connection also proves the client ID and secret, so a stale check is dropped.
 */
export function markRedirectVerified(ctx: Ctx, redirectUri: string): void {
  const c = ctx.settings.getState("google.client");
  if (!c || (c.verifiedRedirectUri === redirectUri && !c.check)) return;
  const { check: _check, ...rest } = c;
  ctx.settings.setState("google.client", { ...rest, verifiedRedirectUri: redirectUri });
}

export function clientCredentials(ctx: Ctx): { clientId: string; clientSecret: string } {
  const c = ctx.settings.getState("google.client");
  if (!c?.clientId || !c.clientSecretEnc) {
    throw new HttpError(
      400,
      "google_client_missing",
      "The Google OAuth client isn't configured yet",
      "Import your OAuth client's JSON (or enter its ID and secret) in the setup wizard's Google step first.",
    );
  }
  return { clientId: c.clientId, clientSecret: ctx.crypto.decrypt(c.clientSecretEnc) };
}

export function projectId(ctx: Ctx): string | null {
  return ctx.settings.getState("google.client")?.projectId || null;
}
