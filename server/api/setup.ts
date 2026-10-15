import type { Context } from "hono";
import { z } from "zod";
import type { GoogleClientView, PubsubState, SetupState, SetupStatus } from "../../shared/types.ts";
import {
  adminAuth,
  checkSecret,
  clientIp,
  hasSession,
  isClaimed,
  lockedOut,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  rejection,
  startSession,
} from "../auth/index.ts";
import { deleteSetupToken, readSetupToken } from "../auth/setup-token.ts";
import { anyAgentVerified } from "../agentapi/listeners.ts";
import type { AppContext } from "../context.ts";
import { cliCommand } from "../instance.ts";
import { hashPasswordAsync, safeEqual } from "../crypto.ts";
import { badRequest, conflict, HttpError } from "../util/errors.ts";
import { readBody, router } from "./util.ts";

const TokenField = z.string().trim().min(1, "Setup token is required").max(200);

const ClaimBody = z.object({
  token: TokenField,
  password: z.string().max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`),
});

const VerifyBody = z.object({ token: TokenField });

/** How to get a working setup link again (the token file is only readable on the server). */
const lostLinkHint = () =>
  `On the server, run \`${cliCommand("reset-password")}\`: it prints the setup link again (nothing is reset while the instance isn't set up yet). ` +
  "Restarting agentinbox prints it too.";

const ALREADY_CLAIMED = () => conflict("This instance is already set up", "Sign in with the admin password instead.");

/** Unauthenticated: first-run status and the one-time claim. Mounted before the admin guard. */
export function setupPublicApi(ctx: AppContext) {
  const auth = adminAuth(ctx);
  return router()
    .get("/setup/status", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json<SetupStatus>({ claimed: isClaimed(ctx), authenticated: hasSession(c, ctx) });
    })
    // Checks the setup token before the password form is filled in. Same limiter and secret key as
    // the claim: a wrong token counts once whichever endpoint sees it, and a correct one clears it.
    .post("/setup/verify-token", async (c) => {
      const ip = clientIp(c, ctx.config.trustProxy);
      const banned = auth.limiter.bannedMinutes(ip);
      if (banned) return lockedOut(c, banned);
      const body = await readBody(c, VerifyBody);
      const rejected = await verifyToken(c, ip, body.token);
      if (rejected) return rejected;
      return c.body(null, 204);
    })
    .post("/setup/claim", async (c) => {
      const ip = clientIp(c, ctx.config.trustProxy);
      const banned = auth.limiter.bannedMinutes(ip);
      if (banned) return lockedOut(c, banned);
      const body = await readBody(c, ClaimBody);
      const rejected = await verifyToken(c, ip, body.token);
      if (rejected) return rejected;
      checkPassword(body.password);
      const hash = await hashPasswordAsync(body.password);
      // A concurrent claim may have won while hashing.
      if (isClaimed(ctx)) throw ALREADY_CLAIMED();
      ctx.settings.setState("admin.passwordHash", hash);
      deleteSetupToken(ctx.config.dataDir);
      auth.limiter.reset();
      startSession(c, ctx);
      ctx.audit.record({ actorType: "admin", action: "admin.claim", outcome: "ok", detail: { ip } });
      return c.body(null, 204);
    });

  /** Rate-limited setup token check: null when it matches, a 429 response, or throws 403/409. */
  async function verifyToken(c: Context, ip: string, token: string): Promise<Response | null> {
    if (isClaimed(ctx)) throw ALREADY_CLAIMED();
    const expected = readSetupToken(ctx.config.dataDir);
    if (!expected) throw new HttpError(403, "setup_token_expired", "This setup link is no longer valid", lostLinkHint());
    const check = await checkSecret(ctx, ip, `claim:${token}`, () => safeEqual(token, expected), { global: false });
    if (check.ok) return null;
    const rejected = rejection(c, check);
    if (rejected) return rejected;
    ctx.audit.record({ actorType: "admin", action: "admin.claim", outcome: "denied", reason: check.nowBanned ? "lockout" : "invalid_token", detail: { ip } });
    throw new HttpError(
      403,
      "invalid_token",
      "This setup token isn't valid",
      `Copy the whole setup link from the terminal (an older link stops working after \`reset-password\`). Lost it? ${lostLinkHint()}`,
    );
  }
}

/** Authenticated: the setup checklist. */
export function setupApi(ctx: AppContext) {
  return router().get("/setup/state", (c) => c.json(setupState(ctx)));
}

export function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > MAX_PASSWORD_LENGTH) throw badRequest(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
}

/**
 * Composes the setup checklist. Reads the stored state directly if a service is unavailable.
 * `warnings: false` skips the warning checks (the health endpoint only needs `complete`).
 */
export function setupState(ctx: AppContext, opts: { warnings?: boolean } = {}): SetupState {
  const claimed = isClaimed(ctx);
  const client = attempt(ctx, () => ctx.google.clientView()) ?? storedClientView(ctx);
  const pubsub = attempt(ctx, () => ctx.google.pubsubState()) ?? storedPubsub(ctx);
  const count = (table: "accounts" | "agents") => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
  const accountsConnected = count("accounts");
  const googleClientConfigured = !!client.clientId && client.hasSecret;
  return {
    claimed,
    googleClientConfigured,
    gcpProjectId: client.projectId,
    googleAppType: client.appType,
    pubsub,
    accountsConnected,
    agentsCreated: count("agents"),
    verified: anyAgentVerified(ctx.db),
    complete: claimed && googleClientConfigured && accountsConnected > 0,
    warnings: opts.warnings === false ? [] : (attempt(ctx, () => ctx.google.setupWarnings()) ?? []),
  };
}

function attempt<T>(ctx: AppContext, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    ctx.log.debug("setup state: falling back to stored state", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function storedClientView(ctx: AppContext): Pick<GoogleClientView, "clientId" | "hasSecret" | "projectId" | "appType"> {
  const s = ctx.settings.getState("google.client");
  return { clientId: s?.clientId || null, hasSecret: !!s?.clientSecretEnc, projectId: s?.projectId || null, appType: s?.appType ?? null };
}

function storedPubsub(ctx: AppContext): PubsubState {
  const s = ctx.settings.getState("pubsub");
  return {
    mode: ctx.settings.get().ingestMode,
    topic: s?.topic ?? null,
    subscription: s?.subscription ?? null,
    lastError: s?.lastError ?? null,
    lastMessageAt: s?.lastMessageAt ?? null,
    principalAccountId: s?.principalAccountId ?? null,
    principalEmail: null,
    pendingPrincipalAccountId: s?.pendingPrincipalAccountId ?? null,
    pendingPrincipalEmail: null,
  };
}
