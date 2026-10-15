// Agent-facing API under /agent/v1 (contract: shared/agent-api.ts): device-flow pairing for
// `npx agentinbox connect` and the event stream for `npx agentinbox listen`. Mounted at the root;
// it uses bearer keys or no auth, so it sits outside the console's cookie/CSRF guard.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AgentSelf } from "../../shared/agent-api.ts";
import { readBody } from "../api/util.ts";
import { clientIp, lockedOut } from "../auth/index.ts";
import { LoginLimiter } from "../auth/lockout.ts";
import type { AppContext } from "../context.ts";
import { HttpError, notFound } from "../util/errors.ts";
import { type AgentApiEnv, agentAuth } from "./auth.ts";
import { createPairingService, type PairingOptions, type PairingService, pairingStartSchema, pollSchema } from "./pairing.ts";
import { RateLimiter, tooManyRequests } from "./ratelimit.ts";
import { ackListener, parseConsumer } from "./listeners.ts";
import { streamEvents } from "./stream.ts";

export interface AgentApiOptions extends PairingOptions {
  /** Stream heartbeat (`: ping` + access re-check). Default 15 s. */
  heartbeatMs?: number;
  /** Pairing starts per client IP per hour. Default 10. */
  startsPerHour?: number;
  /** Pairing polls per client IP per minute, across codes. Default 120. */
  pollsPerMinute?: number;
}

export interface AgentApiState {
  pairings: PairingService;
  options: AgentApiOptions;
  /** Wrong bearer keys per IP. */
  authLimiter: LoginLimiter;
  /** Unknown device codes per IP. */
  codeLimiter: LoginLimiter;
  starts: RateLimiter;
  polls: RateLimiter;
}

const states = new WeakMap<AppContext, AgentApiState>();

/**
 * Per-context agent API state (pairing service and in-memory rate limiters). Passing options
 * (tests: clock, TTL, limits) replaces the state, so do it before `createApp`.
 */
export function agentApi(ctx: AppContext, options?: AgentApiOptions): AgentApiState {
  let state = states.get(ctx);
  if (!state || options) {
    const opts = options ?? {};
    const clock = opts.clock ?? Date.now;
    state = {
      pairings: createPairingService(ctx, opts),
      options: opts,
      authLimiter: new LoginLimiter(clock),
      codeLimiter: new LoginLimiter(clock),
      starts: new RateLimiter(opts.startsPerHour ?? 10, 3600_000, clock),
      polls: new RateLimiter(opts.pollsPerMinute ?? 120, 60_000, clock),
    };
    if (!states.has(ctx)) {
      // No stream survives a restart: connection counts from a previous run are stale.
      ctx.db.run("UPDATE listener_cursors SET connected = 0 WHERE connected <> 0");
    }
    states.set(ctx, state);
  }
  return state;
}

/** Expires overdue pairings (server/maintenance.ts runs this on a short timer). Never throws. */
export function sweepPairings(ctx: AppContext): number {
  try {
    return agentApi(ctx).pairings.sweep();
  } catch (err) {
    ctx.log.warn("Pairing sweep failed", { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

export function agentApiRoutes(ctx: AppContext): Hono<AgentApiEnv> {
  const app = new Hono<AgentApiEnv>();
  agentApi(ctx); // resets stale listener connection counts at startup
  const state = () => agentApi(ctx);
  const ipOf = (c: Parameters<typeof clientIp>[0]) => clientIp(c, ctx.config.trustProxy);
  const denied = (action: string, reason: string, detail: Record<string, unknown>) =>
    ctx.audit.record({ actorType: "system", action, outcome: "denied", reason, detail });

  app.use(
    "/agent/v1/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: { code: "payload_too_large", message: "Request body is too large" } }, 413),
    }),
  );

  // ── Pairing (public) ──
  app.post("/agent/v1/pairings", async (c) => {
    const s = state();
    const ip = ipOf(c);
    const take = s.starts.take(ip);
    if (!take.ok) {
      if (take.firstDenial) denied("pairing.requested", "rate_limit", { ip });
      return tooManyRequests(c, "rate_limited", "Too many pairing requests from this address", take.retryAfter, "Wait a while, or create the agent in the console.");
    }
    if (!ctx.settings.get().pairingEnabled) {
      denied("pairing.requested", "pairing_disabled", { ip });
      throw new HttpError(
        403,
        "pairing_disabled",
        "Pairing is turned off on this agentinbox",
        "An admin can turn on pairing in the console under Settings, or create the agent under Agents and copy its key.",
      );
    }
    const body = await readBody(c, pairingStartSchema);
    s.pairings.sweep();
    if (s.pairings.full()) {
      denied("pairing.requested", "pending_cap", { ip, name: body.name });
      return tooManyRequests(c, "too_many_pending", "Too many pairing requests are waiting for approval", 60, "Approve or deny the waiting requests in the console first.");
    }
    return c.json(s.pairings.start(body, ip));
  });

  app.post("/agent/v1/pairings/poll", async (c) => {
    const s = state();
    const ip = ipOf(c);
    const banned = s.codeLimiter.bannedMinutes(ip);
    if (banned) return lockedOut(c, banned);
    const take = s.polls.take(ip);
    if (!take.ok) {
      if (take.firstDenial) denied("pairing.poll", "rate_limit", { ip });
      return tooManyRequests(c, "rate_limited", "Polling too fast", take.retryAfter, `Poll at most every ${s.pairings.intervalSeconds} seconds.`);
    }
    const { deviceCode } = await readBody(c, pollSchema);
    const result = s.pairings.poll(deviceCode);
    if (!result) {
      // Unknown code: indistinguishable from a pruned request, but guessing gets the address locked out.
      if (s.codeLimiter.fail(ip, deviceCode)) denied("pairing.poll", "lockout", { ip });
      return c.json({ status: "expired" });
    }
    return c.json(result);
  });

  // ── Listener (bearer aib_ key) ──
  const auth = agentAuth(ctx, () => state().authLimiter);
  app.use("/agent/v1/me", auth);
  app.use("/agent/v1/events/*", auth);

  app.get("/agent/v1/me", (c) => {
    const agent = ctx.policy.getAgent(c.get("agent")!.agentId);
    if (!agent) throw notFound("Agent");
    const base = ctx.settings.publicUrl();
    const self: AgentSelf = {
      id: agent.id,
      name: agent.name,
      grants: agent.grants.map((g) => ({
        accountId: g.accountId,
        accountEmail: ctx.accounts.get(g.accountId)?.email ?? "",
        capabilities: g.capabilities,
        labelScope: g.labelScope,
        sendMode: g.sendMode,
      })),
      mcpUrl: `${base}/mcp`,
      skillUrl: `${base}/skill.md`,
    };
    return c.json(self);
  });

  app.get("/agent/v1/events/stream", (c) => streamEvents(ctx, c, { heartbeatMs: state().options.heartbeatMs }));

  app.post("/agent/v1/events/ack", async (c) => {
    const body = await readBody(c, z.object({ consumer: z.string().optional(), seq: z.number().int().nonnegative() }));
    return c.json(ackListener(ctx.db, c.get("agent")!.agentId, parseConsumer(body.consumer), body.seq));
  });

  app.all("/agent/*", (c) => c.json({ error: { code: "not_found", message: "No such agent API route" } }, 404));

  return app;
}
