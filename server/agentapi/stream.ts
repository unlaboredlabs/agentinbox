import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { EVENT_TYPES, type EventType, type ListenerInfo, type MailEvent, type WebhookPayload } from "../../shared/types.ts";
import type { BusEvents } from "../bus.ts";
import type { AppContext } from "../context.ts";
import { json } from "../db/index.ts";
import type { StoredEvent } from "../events/types.ts";
import { toMailEvent } from "../events/repo.ts";
import { badRequest, errorMessage, HttpError } from "../util/errors.ts";
import type { AgentApiEnv } from "./auth.ts";
import { accessProblem, ackedSeq, parseConsumer, type RevokeReason } from "./listeners.ts";

export const HEARTBEAT_MS = 15_000;
const BATCH = 100;
const CONTENT_TIMEOUT_MS = 20_000;

const short = (v: unknown, max = 100) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Listener client info: `x-agentinbox-client` JSON header, else query params, else the user agent. */
function clientInfo(c: Context): ListenerInfo["client"] {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(c.req.header("x-agentinbox-client") ?? "{}");
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // Ignore a malformed header: it's informational.
  }
  const ua = /agentinbox[\w-]*\/(\S+)/i.exec(c.req.header("user-agent") ?? "")?.[1];
  const info: ListenerInfo["client"] = {
    hostname: short(raw.hostname) ?? short(c.req.query("hostname")),
    platform: short(raw.platform, 50) ?? short(c.req.query("platform"), 50),
    version: short(raw.version, 50) ?? short(c.req.query("version"), 50) ?? short(ua, 50),
  };
  return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined));
}

function parseSeq(raw: string | undefined, name: string, strict: boolean): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  if (strict) throw badRequest(`${name} must be a non-negative integer`);
  return 0;
}

function parseTypes(raw: string | undefined): EventType[] | undefined {
  if (!raw) return undefined;
  const types = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = types.filter((t) => !EVENT_TYPES.includes(t as EventType));
  if (bad.length) throw badRequest(`Unknown event type ${bad.join(", ")}`, `Use any of ${EVENT_TYPES.join(", ")}`);
  return types.length ? (types as EventType[]) : undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    }),
  ]);
}

/** Same body as a webhook delivery (server/webhooks): the event, plus cleaned content on request. */
async function payload(ctx: AppContext, event: StoredEvent, includeBody: boolean): Promise<WebhookPayload> {
  const data: WebhookPayload["data"] & { contentError?: string } = toMailEvent(event);
  if (includeBody && event.message) {
    try {
      data.content = await withTimeout(ctx.mail.messageContent(event.accountId, event.message.id), CONTENT_TIMEOUT_MS);
    } catch (err) {
      data.contentError = `Message body unavailable: ${errorMessage(err)}`.slice(0, 300);
    }
  }
  return { type: event.type, timestamp: event.createdAt, data };
}

/**
 * GET /agent/v1/events/stream. Backlog first (events.feed in batches), then live bus events; each
 * event's visibility is re-checked right before it is written. Revocation (bus "agent", and every
 * heartbeat as a backstop) ends the stream with `event: revoked`.
 */
export function streamEvents(ctx: AppContext, c: Context<AgentApiEnv>, opts: { heartbeatMs?: number } = {}): Response {
  const { agentId } = c.get("agent")!;
  const keyHash = c.get("keyHash");
  const consumer = parseConsumer(c.req.query("consumer"));
  const types = parseTypes(c.req.query("types"));
  const includeBody = ["1", "true"].includes(c.req.query("include_body") ?? "");
  const after = parseSeq(c.req.query("after"), "after", true);
  const lastEventId = parseSeq(c.req.header("last-event-id"), "Last-Event-ID", false);
  const problem = accessProblem(ctx.db, agentId, keyHash);
  if (problem) {
    throw new HttpError(403, problem, "This agent has no read access to any account", "Grant it read access to an account in the agentinbox console.");
  }

  const { db } = ctx;
  const log = ctx.log.child("listen");
  const touch = (delta: number) =>
    db.run(
      "UPDATE listener_cursors SET connected = MAX(0, connected + ?), last_seen_at = ? WHERE agent_id = ? AND consumer = ?",
      delta,
      new Date().toISOString(),
      agentId,
      consumer,
    );
  const t = new Date().toISOString();
  db.run(
    `INSERT INTO listener_cursors (agent_id, consumer, acked_seq, client, connected, last_seen_at, updated_at) VALUES (?, ?, 0, ?, 1, ?, ?)
     ON CONFLICT(agent_id, consumer) DO UPDATE SET client = excluded.client, connected = connected + 1, last_seen_at = excluded.last_seen_at`,
    agentId,
    consumer,
    json.str(clientInfo(c)),
    t,
    t,
  );
  let cursor = Math.max(after, lastEventId, ackedSeq(db, agentId, consumer));

  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let closed = false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const close = () => {
      closed = true;
      finish();
    };

    const revoke = (reason: RevokeReason) => {
      if (closed) return;
      closed = true;
      // Written directly (frames are single writes), so a slow body fetch can't delay it.
      stream.writeSSE({ event: "revoked", data: JSON.stringify({ reason }) }).then(finish, finish);
    };
    const checkAccess = () => {
      const reason = accessProblem(db, agentId, keyHash);
      if (reason) revoke(reason);
      return !reason;
    };

    let pumping = false;
    let again = false;
    const pump = async () => {
      if (pumping) {
        again = true;
        return;
      }
      pumping = true;
      try {
        do {
          again = false;
          for (;;) {
            if (closed || !checkAccess()) return;
            const from = cursor;
            const batch = ctx.events.feed(agentId, { after: from, limit: BATCH, types });
            for (const ev of batch.events) {
              const stored = ctx.events.get(ev.id);
              if (!stored || !ctx.policy.canSeeEvent(agentId, stored)) continue;
              const body = JSON.stringify(await payload(ctx, stored, includeBody));
              if (closed) return;
              await stream.writeSSE({ id: String(ev.seq), event: "mail", data: body });
            }
            cursor = Math.max(cursor, batch.cursor);
            if (cursor === from) break;
          }
        } while (again);
      } catch (err) {
        if (!closed) log.warn("Listener stream failed", { agent: agentId, consumer, error: errorMessage(err) });
        close();
      } finally {
        pumping = false;
      }
    };

    const onEvent = (ev: MailEvent) => {
      if (ev.seq > cursor && (!types || types.includes(ev.type))) void pump();
    };
    const onAgent = (change: BusEvents["agent"][0]) => {
      if (change.agentId === agentId) checkAccess();
    };
    ctx.bus.on("event", onEvent);
    ctx.bus.on("agent", onAgent);
    const heartbeat = setInterval(() => {
      if (closed || !checkAccess()) return;
      touch(0);
      stream.write(": ping\n\n").catch(close);
    }, opts.heartbeatMs ?? HEARTBEAT_MS);

    stream.onAbort(close);
    c.req.raw.signal.addEventListener("abort", close, { once: true });
    if (stream.aborted || c.req.raw.signal.aborted) close();

    try {
      await stream.write(": connected\n\n").then(() => void pump(), close);
      await done;
    } finally {
      clearInterval(heartbeat);
      ctx.bus.off("event", onEvent);
      ctx.bus.off("agent", onAgent);
      try {
        touch(-1);
      } catch {
        // The database may already be closed on shutdown.
      }
    }
  });
}
