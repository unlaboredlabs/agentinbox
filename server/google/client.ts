import type { GoogleClientConfig, GoogleClientView } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { badRequest } from "../util/errors.ts";

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
  const clientId = input.clientId.trim();
  const projectId = input.projectId.trim();
  if (!clientId.endsWith(".apps.googleusercontent.com")) {
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
  ctx.settings.setState("google.client", { clientId, clientSecretEnc, projectId, appType: input.appType });
  return clientView(ctx);
}

export function clientCredentials(ctx: Ctx): { clientId: string; clientSecret: string } {
  const c = ctx.settings.getState("google.client");
  if (!c?.clientId || !c.clientSecretEnc) {
    throw badRequest(
      "The Google OAuth client isn't configured yet",
      "Add your OAuth client ID and secret in the setup wizard (Google step) first.",
    );
  }
  return { clientId: c.clientId, clientSecret: ctx.crypto.decrypt(c.clientSecretEnc) };
}

export function projectId(ctx: Ctx): string | null {
  return ctx.settings.getState("google.client")?.projectId || null;
}
