import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../api/util.ts";
import type { CoreContext } from "../context.ts";
import { HttpError } from "../util/errors.ts";
import { LoginLimiter } from "./lockout.ts";
import { SESSION_TTL_MS, SessionStore } from "./sessions.ts";
import { ensureSetupToken, regenerateSetupToken } from "./setup-token.ts";

export const SESSION_COOKIE = "aib_session";
export const CSRF_HEADER = "x-agentinbox-csrf";
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;

/** Per-context admin auth state: the session store and the failed-login limiter. */
export interface AdminAuth {
  sessions: SessionStore;
  limiter: LoginLimiter;
}

/** What admin auth needs from the context (the CLI builds this without loading the master key). */
export type AuthCore = Pick<CoreContext, "db" | "settings" | "audit" | "config">;

const instances = new WeakMap<AuthCore, AdminAuth>();

export function adminAuth(ctx: AuthCore): AdminAuth {
  let auth = instances.get(ctx);
  if (!auth) {
    auth = { sessions: new SessionStore(ctx.db), limiter: new LoginLimiter() };
    instances.set(ctx, auth);
  }
  return auth;
}

/** Claimed = an admin password exists. Before that only the setup-token claim works. */
export const isClaimed = (ctx: AuthCore): boolean => !!ctx.settings.getState("admin.passwordHash");

/** The current setup token while unclaimed (created on demand), otherwise null. */
export function currentSetupToken(ctx: AuthCore): string | null {
  return isClaimed(ctx) ? null : ensureSetupToken(ctx.config.dataDir);
}

/** `agentinbox reset-password`: back to the unclaimed state with a fresh setup link. */
export function resetAdminPassword(ctx: AuthCore): string {
  const auth = adminAuth(ctx);
  ctx.db.tx(() => {
    ctx.settings.deleteState("admin.passwordHash");
    auth.sessions.deleteAll();
  });
  auth.limiter.reset();
  ctx.audit.record({ actorType: "system", action: "admin.password_reset", outcome: "ok" });
  return regenerateSetupToken(ctx.config.dataDir);
}

/**
 * The client address. Behind a trusted proxy, X-Forwarded-For is read from the right: proxies
 * append the address they saw, so entries further left are client-controlled. TRUST_PROXY_HOPS
 * (default 1) is the number of proxies in front of agentinbox.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const hops = Math.max(1, Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10) || 1);
    const chain = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const forwarded = chain[chain.length - hops];
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // No Node socket (e.g. app.request() in tests).
    return "unknown";
  }
}

function isSecure(c: Context, trustProxy: boolean): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  return trustProxy && c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE) || undefined;
}

function writeSessionCookie(c: Context, token: string, trustProxy: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecure(c, trustProxy),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Creates a session for the requester and sets the cookie. */
export function startSession(c: Context, ctx: AuthCore): void {
  const token = adminAuth(ctx).sessions.create({ ip: clientIp(c, ctx.config.trustProxy), userAgent: c.req.header("user-agent") });
  writeSessionCookie(c, token, ctx.config.trustProxy);
}

export function endSession(c: Context, ctx: AuthCore): void {
  const token = sessionToken(c);
  if (token) adminAuth(ctx).sessions.delete(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Whether the request carries a valid session; refreshes the cookie when the expiry slid forward. */
export function hasSession(c: Context, ctx: AuthCore): boolean {
  const token = sessionToken(c);
  const check = adminAuth(ctx).sessions.check(token);
  if (check.refreshed && token) writeSessionCookie(c, token, ctx.config.trustProxy);
  return check.valid;
}

/** Requires an admin session on every route it guards. */
export function requireAdmin(ctx: AuthCore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hasSession(c, ctx)) {
      if (!isClaimed(ctx)) {
        throw new HttpError(401, "setup_required", "This instance has not been claimed yet", "Open the setup link printed by agentinbox on startup.");
      }
      throw new HttpError(401, "unauthorized", "Sign in to continue");
    }
    c.set("admin", true);
    await next();
  };
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF guard: a custom header can't be sent cross-site without a CORS preflight (which this server
 * never approves), and SameSite=Lax already keeps the cookie off cross-site POSTs.
 */
export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (MUTATING.has(c.req.method) && c.req.header(CSRF_HEADER) !== "1") {
      throw new HttpError(403, "csrf", `Missing ${CSRF_HEADER} header`, `Send "${CSRF_HEADER}: 1" with every mutating /api request.`);
    }
    await next();
  };
}

/** 429 response for a locked-out address. */
export function lockedOut(c: Context, minutes: number): Response {
  c.header("Retry-After", String(minutes * 60));
  const message = `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  return c.json({ error: { code: "locked_out", message } }, 429);
}

export type CheckResult = { ok: true } | { ok: false; lockedMinutes: number; nowBanned: boolean };

/**
 * Verifies a secret under the failed-login limiter. Locked-out clients and secrets this client
 * already failed with are rejected without running `verify` (scrypt).
 */
export async function checkSecret(ctx: AuthCore, ip: string, secret: string, verify: () => boolean | Promise<boolean>): Promise<CheckResult> {
  const { limiter } = adminAuth(ctx);
  const locked = limiter.bannedMinutes(ip);
  if (locked) return { ok: false, lockedMinutes: locked, nowBanned: false };
  if (!limiter.knownBad(ip, secret) && (await verify())) {
    limiter.clear(ip);
    return { ok: true };
  }
  const nowBanned = limiter.fail(ip, secret);
  return { ok: false, lockedMinutes: 0, nowBanned };
}
