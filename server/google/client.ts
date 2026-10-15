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
  };
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
  ctx.settings.setState("google.client", {
    clientId,
    clientSecretEnc,
    projectId,
    appType: input.appType,
    ...(importedRedirectUris ? { importedRedirectUris } : {}),
    verifiedRedirectUri: same ? (prev?.verifiedRedirectUri ?? null) : null,
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
export function importClient(ctx: Ctx, input: GoogleClientImportInput): GoogleClientImportResult {
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

/**
 * `redirect_uri_missing` when the last imported JSON doesn't list the exact redirect URI and no
 * account has connected through it since (which proves Google has it registered).
 */
export function redirectWarning(ctx: Ctx): SetupWarning | null {
  const c = ctx.settings.getState("google.client");
  const registered = c?.importedRedirectUris;
  if (!c?.clientId || !registered) return null;
  const uri = callbackMode(ctx).redirectUri;
  if (registered.includes(uri) || c.verifiedRedirectUri === uri) return null;
  const listed = registered.length ? `It lists: ${registered.join(", ")}.` : "It lists none.";
  const project = c.projectId ? `?project=${encodeURIComponent(c.projectId)}` : "";
  return {
    code: "redirect_uri_missing",
    severity: "error",
    message: `Your OAuth client's Authorized redirect URIs don't include ${uri}, so Google will refuse to connect accounts. ${listed}`,
    hint:
      `In Google Cloud → Clients → your client → Authorized redirect URIs, add ${uri} exactly (no trailing slash) and save. ` +
      "You don't need to download the JSON again (it's only used here to read the ID and secret): this warning clears as soon as an account connects, or re-import the new JSON to re-check now.",
    url: `https://console.cloud.google.com/auth/clients/${encodeURIComponent(c.clientId)}${project}`,
  };
}

/** Records that Google accepted `redirectUri` for the saved client (an account just connected through it). */
export function markRedirectVerified(ctx: Ctx, redirectUri: string): void {
  const c = ctx.settings.getState("google.client");
  if (c && c.verifiedRedirectUri !== redirectUri) ctx.settings.setState("google.client", { ...c, verifiedRedirectUri: redirectUri });
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
