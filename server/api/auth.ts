import { z } from "zod";
import { adminAuth, clientIp, endSession, isClaimed, lockedOut, sessionToken, startSession } from "../auth/index.ts";
import type { AppContext } from "../context.ts";
import { hashPassword, verifyPassword } from "../crypto.ts";
import { conflict, HttpError } from "../util/errors.ts";
import { checkPassword } from "./setup.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const LoginBody = z.object({ password: z.string().min(1, "Password is required") });
const PasswordBody = z.object({ current: z.string(), next: z.string() });

/** Unauthenticated: sign in and out. Mounted before the admin guard. */
export function authPublicApi(ctx: AppContext) {
  const auth = adminAuth(ctx);
  return router()
    .post("/auth/login", async (c) => {
      const ip = clientIp(c, ctx.config.trustProxy);
      const banned = auth.limiter.bannedMinutes(ip);
      if (banned) return lockedOut(c, banned);
      const { password } = await readBody(c, LoginBody);
      const hash = ctx.settings.getState("admin.passwordHash");
      if (!hash) throw conflict("This instance has not been claimed yet", "Open the setup link printed by agentinbox on startup.");
      if (!verifyPassword(password, hash)) {
        const nowBanned = auth.limiter.fail(ip, password);
        ctx.audit.record({ ...ADMIN_ACTOR, action: "admin.login", outcome: "denied", reason: nowBanned ? "lockout" : "bad_password", detail: { ip } });
        throw new HttpError(401, "invalid_password", "Wrong password");
      }
      auth.limiter.clear(ip);
      startSession(c, ctx);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "admin.login", outcome: "ok", detail: { ip } });
      return c.body(null, 204);
    })
    .post("/auth/logout", (c) => {
      endSession(c, ctx);
      return c.body(null, 204);
    });
}

/** Authenticated: change the admin password. Revokes every other session. */
export function authApi(ctx: AppContext) {
  const auth = adminAuth(ctx);
  return router().post("/auth/password", async (c) => {
    const ip = clientIp(c, ctx.config.trustProxy);
    const banned = auth.limiter.bannedMinutes(ip);
    if (banned) return lockedOut(c, banned);
    const body = await readBody(c, PasswordBody);
    const hash = ctx.settings.getState("admin.passwordHash");
    if (!isClaimed(ctx) || !hash || !verifyPassword(body.current, hash)) {
      auth.limiter.fail(ip, body.current);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "admin.password_change", outcome: "denied", reason: "bad_password", detail: { ip } });
      throw new HttpError(400, "invalid_password", "Current password is wrong");
    }
    checkPassword(body.next);
    ctx.settings.setState("admin.passwordHash", hashPassword(body.next));
    const revoked = auth.sessions.deleteAll(sessionToken(c));
    ctx.audit.record({ ...ADMIN_ACTOR, action: "admin.password_change", outcome: "ok", detail: { ip, revokedSessions: revoked } });
    return c.body(null, 204);
  });
}
