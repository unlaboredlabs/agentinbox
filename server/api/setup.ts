import { z } from "zod";
import type { GoogleClientView, PubsubState, SetupState, SetupStatus } from "../../shared/types.ts";
import {
  adminAuth,
  clientIp,
  hasSession,
  isClaimed,
  lockedOut,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  startSession,
} from "../auth/index.ts";
import { deleteSetupToken, readSetupToken } from "../auth/setup-token.ts";
import type { AppContext } from "../context.ts";
import { hashPassword, safeEqual } from "../crypto.ts";
import { badRequest, conflict, HttpError } from "../util/errors.ts";
import { readBody, router } from "./util.ts";

const ClaimBody = z.object({ token: z.string().trim().min(1, "Setup token is required"), password: z.string() });

/** Unauthenticated: first-run status and the one-time claim. Mounted before the admin guard. */
export function setupPublicApi(ctx: AppContext) {
  const auth = adminAuth(ctx);
  return router()
    .get("/setup/status", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json<SetupStatus>({ claimed: isClaimed(ctx), authenticated: hasSession(c, ctx) });
    })
    .post("/setup/claim", async (c) => {
      const ip = clientIp(c, ctx.config.trustProxy);
      const banned = auth.limiter.bannedMinutes(ip);
      if (banned) return lockedOut(c, banned);
      const body = await readBody(c, ClaimBody);
      if (isClaimed(ctx)) throw conflict("This instance is already claimed", "Sign in with the admin password instead.");
      const expected = readSetupToken(ctx.config.dataDir);
      if (!expected) {
        throw new HttpError(403, "invalid_token", "The setup link has expired", "Restart agentinbox or run `agentinbox reset-password` for a new link.");
      }
      if (!safeEqual(body.token, expected)) {
        auth.limiter.fail(ip, `claim:${body.token}`);
        ctx.audit.record({ actorType: "admin", action: "admin.claim", outcome: "denied", reason: "invalid_token", detail: { ip } });
        throw new HttpError(403, "invalid_token", "Invalid setup token", "Use the exact setup link printed by agentinbox on startup.");
      }
      checkPassword(body.password);
      ctx.settings.setState("admin.passwordHash", hashPassword(body.password));
      deleteSetupToken(ctx.config.dataDir);
      auth.limiter.clear(ip);
      startSession(c, ctx);
      ctx.audit.record({ actorType: "admin", action: "admin.claim", outcome: "ok", detail: { ip } });
      return c.body(null, 204);
    });
}

/** Authenticated: the setup checklist. */
export function setupApi(ctx: AppContext) {
  return router().get("/setup/state", (c) => c.json(setupState(ctx)));
}

export function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > MAX_PASSWORD_LENGTH) throw badRequest(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
}

/** Composes the setup checklist. Reads the stored state directly if a service is unavailable. */
export function setupState(ctx: AppContext): SetupState {
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
    complete: claimed && googleClientConfigured && accountsConnected > 0,
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
  };
}
