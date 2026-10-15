import { z } from "zod";
import { adminAuth, checkSecret, clientIp, endSession, lockedOut, MAX_PASSWORD_LENGTH, sessionToken, startSession } from "../auth/index.ts";
import type { AppContext } from "../context.ts";
import { hashPasswordAsync, verifyPasswordAsync } from "../crypto.ts";
import { conflict, HttpError } from "../util/errors.ts";
import { checkPassword } from "./setup.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const password = (what: string) => z.string().max(MAX_PASSWORD_LENGTH, `${what} must be at most ${MAX_PASSWORD_LENGTH} characters`);
const LoginBody = z.object({ password: password("Password").min(1, "Password is required") });
const PasswordBody = z.object({ current: password("Current password"), next: password("New password") });

/** Unauthenticated: sign in and out. Mounted before the admin guard. */
export function authPublicApi(ctx: AppContext) {
  const auth = adminAuth(ctx);
  return router()
    .post("/auth/login", async (c) => {
      const ip = clientIp(c, ctx.config.trustProxy);
      const banned = auth.limiter.bannedMinutes(ip);
      if (banned) return lockedOut(c, banned);
      const body = await readBody(c, LoginBody);
      const hash = ctx.settings.getState("admin.passwordHash");
      if (!hash) throw conflict("This instance has not been claimed yet", "Open the setup link printed by agentinbox on startup.");
      const check = await checkSecret(ctx, ip, body.password, () => verifyPasswordAsync(body.password, hash));
      if (!check.ok) {
        if (check.lockedMinutes) return lockedOut(c, check.lockedMinutes);
        ctx.audit.record({ ...ADMIN_ACTOR, action: "admin.login", outcome: "denied", reason: check.nowBanned ? "lockout" : "bad_password", detail: { ip } });
        throw new HttpError(401, "invalid_password", "Wrong password");
      }
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
    const check = await checkSecret(ctx, ip, body.current, async () => !!hash && (await verifyPasswordAsync(body.current, hash)));
    if (!check.ok) {
      if (check.lockedMinutes) return lockedOut(c, check.lockedMinutes);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "admin.password_change", outcome: "denied", reason: check.nowBanned ? "lockout" : "bad_password", detail: { ip } });
      throw new HttpError(400, "invalid_password", "Current password is wrong");
    }
    checkPassword(body.next);
    ctx.settings.setState("admin.passwordHash", await hashPasswordAsync(body.next));
    const revoked = auth.sessions.deleteAll(sessionToken(c));
    // Secrets that were wrong before may be the password now.
    auth.limiter.reset();
    ctx.audit.record({ ...ADMIN_ACTOR, action: "admin.password_change", outcome: "ok", detail: { ip, revokedSessions: revoked } });
    return c.body(null, 204);
  });
}
