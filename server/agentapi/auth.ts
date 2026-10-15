import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../api/util.ts";
import { clientIp, lockedOut } from "../auth/index.ts";
import { BAN_MS, clientKey, type LoginLimiter } from "../auth/lockout.ts";
import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";

/** AppEnv plus the hash of the key the request authenticated with (streams re-check it on revocation). */
export type AgentApiEnv = { Variables: AppEnv["Variables"] & { keyHash: string } };

export const bearer = (header: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1]! : null;
};

/**
 * Bearer `aib_…` auth for /agent/v1. The key is checked first and a valid key is never refused, so
 * bogus keys from a shared address (NAT, proxy) can't lock out real listeners. Only failures are
 * limited: 5 distinct wrong keys from one client (IPv4 address or IPv6 /64) → 429 for 15 minutes.
 * Keys carry 160 bits of entropy, so the lockout bounds noise rather than guarding a guessable secret.
 */
function disabledAgentKey(ctx: AppContext, key: string): boolean {
  if (!key.startsWith("aib_") || key.length > 200) return false;
  return !!ctx.db.get("SELECT 1 FROM agents WHERE key_hash = ? AND disabled = 1", sha256(key));
}

export function agentAuth(ctx: AppContext, limiterOf: () => LoginLimiter): MiddlewareHandler<AgentApiEnv> {
  return async (c, next) => {
    const key = bearer(c.req.header("authorization"));
    const principal = key ? ctx.policy.authenticate(key) : null;
    if (!principal && key && disabledAgentKey(ctx, key)) {
      // A real key of a disabled agent: no access, but tell the listener so it can wait for re-enable.
      return c.json({ error: { code: "agent_disabled", message: "This agent is disabled", hint: "An admin can enable it in the agentinbox console under Agents." } }, 403);
    }
    if (!principal) {
      const limiter = limiterOf();
      const ip = clientIp(c, ctx.config.trustProxy);
      const source = clientKey(ip);
      const banned = limiter.bannedMinutes(source);
      if (banned) return lockedOut(c, banned);
      if (key && limiter.fail(source, key, { global: false })) {
        ctx.audit.record({
          actorType: "system",
          action: "agent_api.auth",
          outcome: "denied",
          reason: "lockout",
          detail: { ip, path: c.req.path, minutes: BAN_MS / 60_000 },
        });
      }
      c.header("WWW-Authenticate", 'Bearer realm="agentinbox"');
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: key ? "Invalid or disabled agent API key." : "Missing agent API key.",
            hint: "Send the agent's key as `Authorization: Bearer aib_…`, or pair again with `npx agentinbox-cli connect`.",
          },
        },
        401,
      );
    }
    c.set("agent", principal);
    c.set("keyHash", sha256(key!));
    await next();
  };
}
