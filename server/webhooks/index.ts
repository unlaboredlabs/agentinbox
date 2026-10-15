import { z } from "zod";
import type { Delivery, DeliveryStatus, EventType, MessageContent, Page, Webhook, WebhookFilter, WebhookPayload, WebhookWithSecret } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { bool, json, now, type Param } from "../db/index.ts";
import { eventBySeq, TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_ID, toMailEvent } from "../events/repo.ts";
import type { StoredEvent } from "../events/types.ts";
import { badRequest, errorMessage, notFound } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";
import { DELIVERY_SELECT, type DeliveryRow, deliveryById, toDelivery } from "./deliveries.ts";
import { matchesFilter, normalizeFilter, webhookInputSchema, webhookPatchSchema } from "./filter.ts";
import { newSecret, postPinned, secretPrefix, type SendResult, sign } from "./send.ts";
import { type LookupFn, resolveTarget, SsrfError } from "./ssrf.ts";
import type { WebhooksService } from "./types.ts";

/** Delay before each retry: after the n-th failed attempt, wait RETRY_SCHEDULE_MS[n-1]; after the last, the delivery is dead. */
export const RETRY_SCHEDULE_MS = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600].map((s) => s * 1000);

export interface WebhooksOptions {
  retryScheduleMs?: number[];
  /** Worker poll interval. New deliveries also wake it immediately. */
  tickMs?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** DNS resolver for the SSRF guard (tests). */
  lookup?: LookupFn;
}

interface WebhookRow {
  id: string;
  agent_id: string;
  name: string;
  url: string;
  secret_enc: string;
  secret_prefix: string;
  event_types: string;
  filter: string;
  include_body: number;
  enabled: number;
  created_at: string;
  succeeded_24h: number;
  failed_24h: number;
  last_delivery_at: string | null;
}

/** ?1 = the 24 h cutoff; further plain `?` params bind from 2. */
const WEBHOOK_SELECT = `SELECT w.*,
  (SELECT COUNT(*) FROM deliveries d WHERE d.webhook_id = w.id AND d.status = 'succeeded' AND d.updated_at >= ?1) AS succeeded_24h,
  (SELECT COUNT(*) FROM deliveries d WHERE d.webhook_id = w.id AND d.status IN ('failed', 'dead') AND d.updated_at >= ?1) AS failed_24h,
  (SELECT MAX(d.updated_at) FROM deliveries d WHERE d.webhook_id = w.id AND d.attempts > 0) AS last_delivery_at
  FROM webhooks w`;

const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  agentId: r.agent_id,
  name: r.name,
  url: r.url,
  eventTypes: json.parse<EventType[]>(r.event_types, []),
  filter: json.parse<WebhookFilter>(r.filter, {}),
  includeBody: bool(r.include_body),
  enabled: bool(r.enabled),
  secretPrefix: r.secret_prefix,
  createdAt: r.created_at,
  stats: { succeeded24h: r.succeeded_24h, failed24h: r.failed_24h, lastDeliveryAt: r.last_delivery_at },
});

interface AttemptRow {
  id: string;
  event_seq: number;
  attempts: number;
  url: string;
  secret_enc: string;
  include_body: number;
  agent_id: string;
}

type PayloadData = WebhookPayload["data"] & { contentError?: string };

const CONTENT_TIMEOUT_MS = 20_000;

const TEST_CONTENT: MessageContent = {
  body: "This is a **test delivery** from agentinbox. It is not a real email.",
  truncated: false,
  attachments: [],
  signals: { hiddenContentRemoved: false, suspiciousInstructions: [], auth: null, external: true },
};

export function createWebhooksService(ctx: AppContext, options: WebhooksOptions = {}): WebhooksService {
  const log = ctx.log.child("webhooks");
  const schedule = options.retryScheduleMs ?? RETRY_SCHEDULE_MS;
  const tickMs = options.tickMs ?? 1000;
  const concurrency = options.concurrency ?? 8;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const inflight = new Map<string, Promise<void>>();
  let shutdown = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let wakeQueued = false;

  const since24h = () => new Date(Date.now() - 24 * 3600_000).toISOString();

  // ───────────── CRUD ─────────────

  function row(id: string): WebhookRow | undefined {
    return ctx.db.get<WebhookRow>(`${WEBHOOK_SELECT} WHERE w.id = ?`, since24h(), id);
  }

  function requireRow(id: string): WebhookRow {
    const r = row(id);
    if (!r) throw notFound("Webhook");
    return r;
  }

  function list(agentId?: string): Webhook[] {
    const rows = agentId
      ? ctx.db.all<WebhookRow>(`${WEBHOOK_SELECT} WHERE w.agent_id = ? ORDER BY w.created_at DESC`, since24h(), agentId)
      : ctx.db.all<WebhookRow>(`${WEBHOOK_SELECT} ORDER BY w.created_at DESC`, since24h());
    return rows.map(toWebhook);
  }

  function get(id: string): Webhook | null {
    const r = row(id);
    return r ? toWebhook(r) : null;
  }

  function requireAgent(agentId: string): void {
    if (!ctx.db.get("SELECT 1 FROM agents WHERE id = ?", agentId)) throw badRequest("Agent not found", "Webhooks belong to an existing agent.");
  }

  /** Create/update-time SSRF check. Transient DNS failures pass; every delivery checks again. */
  async function checkUrl(url: string): Promise<void> {
    try {
      await resolveTarget(new URL(url), ctx.settings.get().webhookAllowlist, options.lookup);
    } catch (err) {
      if (err instanceof SsrfError && err.kind !== "dns") throw badRequest(err.message, err.hint);
      if (!(err instanceof SsrfError)) throw err;
    }
  }

  async function create(input: z.input<typeof webhookInputSchema>): Promise<WebhookWithSecret> {
    const v = parse(webhookInputSchema, input);
    requireAgent(v.agentId);
    await checkUrl(v.url);
    const id = newId("whk");
    const secret = newSecret();
    ctx.db.run(
      `INSERT INTO webhooks (id, agent_id, name, url, secret_enc, secret_prefix, event_types, filter, include_body, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      v.agentId,
      v.name,
      v.url,
      ctx.crypto.encrypt(secret),
      secretPrefix(secret),
      json.str([...new Set(v.eventTypes)]),
      json.str(normalizeFilter(v.filter)),
      v.includeBody ? 1 : 0,
      v.enabled ? 1 : 0,
      now(),
    );
    return { webhook: get(id)!, secret };
  }

  async function update(id: string, patch: z.input<typeof webhookPatchSchema>): Promise<Webhook> {
    const current = toWebhook(requireRow(id));
    const p = parse(webhookPatchSchema, patch);
    if (p.agentId !== undefined && p.agentId !== current.agentId) requireAgent(p.agentId);
    if (p.url !== undefined && p.url !== current.url) await checkUrl(p.url);
    const next = { ...current, ...stripUndefined(p) };
    ctx.db.run(
      `UPDATE webhooks SET agent_id = ?, name = ?, url = ?, event_types = ?, filter = ?, include_body = ?, enabled = ? WHERE id = ?`,
      next.agentId,
      next.name,
      next.url,
      json.str([...new Set(next.eventTypes)]),
      json.str(normalizeFilter(next.filter)),
      next.includeBody ? 1 : 0,
      next.enabled ? 1 : 0,
      id,
    );
    if (next.enabled && !current.enabled) wake();
    return get(id)!;
  }

  function rotateSecret(id: string): WebhookWithSecret {
    requireRow(id);
    const secret = newSecret();
    ctx.db.run("UPDATE webhooks SET secret_enc = ?, secret_prefix = ? WHERE id = ?", ctx.crypto.encrypt(secret), secretPrefix(secret), id);
    return { webhook: get(id)!, secret };
  }

  function remove(id: string): void {
    ctx.db.tx(() => {
      if (ctx.db.run("DELETE FROM webhooks WHERE id = ?", id).changes === 0) throw notFound("Webhook");
      deleteOrphanTestEvents();
    });
  }

  function deleteOrphanTestEvents(): void {
    ctx.db.run("DELETE FROM events WHERE seq < 0 AND seq NOT IN (SELECT event_seq FROM deliveries)");
  }

  // ───────────── Deliveries ─────────────

  function listDeliveries(q: { webhookId?: string; status?: DeliveryStatus; cursor?: string | null; limit?: number }): Page<Delivery> {
    const where: string[] = [];
    const params: Param[] = [];
    if (q.webhookId) {
      where.push("d.webhook_id = ?");
      params.push(q.webhookId);
    }
    if (q.status) {
      where.push("d.status = ?");
      params.push(q.status);
    }
    const before = Number(q.cursor);
    if (q.cursor && Number.isInteger(before)) {
      where.push("d.rowid < ?");
      params.push(before);
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = ctx.db.all<DeliveryRow>(
      `${DELIVERY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.rowid DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return { items: page.map(toDelivery), nextCursor: rows.length > limit ? String(page.at(-1)!.rid) : null };
  }

  /** Runs inside events.emit's transaction. */
  function enqueue(event: StoredEvent): number {
    const hooks = ctx.db.all<{ id: string; agent_id: string; event_types: string; filter: string }>(
      `SELECT w.id, w.agent_id, w.event_types, w.filter FROM webhooks w JOIN agents a ON a.id = w.agent_id
       WHERE w.enabled = 1 AND a.disabled = 0`,
    );
    const ts = now();
    let count = 0;
    for (const w of hooks) {
      if (!json.parse<EventType[]>(w.event_types, []).includes(event.type)) continue;
      if (!matchesFilter(json.parse<WebhookFilter>(w.filter, {}), event)) continue;
      if (!ctx.policy.canSeeEvent(w.agent_id, event)) continue;
      count += ctx.db.run(
        `INSERT INTO deliveries (id, webhook_id, event_seq, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT(webhook_id, event_seq) DO NOTHING`,
        newId("dlv"),
        w.id,
        event.seq,
        ts,
        ts,
        ts,
      ).changes;
    }
    return count;
  }

  async function test(id: string): Promise<Delivery> {
    requireRow(id);
    const deliveryId = ctx.db.tx(() => {
      const ts = now();
      const seq = ctx.db.get<{ s: number }>("SELECT MIN(COALESCE(MIN(seq), 0), 0) - 1 AS s FROM events")!.s;
      const evtId = newId("evt");
      const msgId = `test_${randomToken(16)}`;
      const message = {
        id: msgId,
        threadId: msgId,
        from: { name: "Ada Lovelace (test)", email: "ada@example.com" },
        to: [{ name: null, email: TEST_ACCOUNT_EMAIL }],
        cc: [],
        subject: "Test event from agentinbox",
        snippet: "This is a test delivery sent from the agentinbox console. It is not a real email.",
        date: ts,
        labelIds: ["INBOX", "UNREAD"],
        hasAttachments: false,
      };
      ctx.db.run(
        `INSERT INTO events (seq, id, type, account_id, gmail_message_id, gmail_thread_id, label_ids, message, detail, dedupe_key, created_at)
         VALUES (?, ?, 'message.received', ?, ?, ?, ?, ?, ?, ?, ?)`,
        seq,
        evtId,
        TEST_ACCOUNT_ID,
        msgId,
        msgId,
        json.str(message.labelIds),
        json.str(message),
        json.str({ test: true }),
        `test:${evtId}`,
        ts,
      );
      const dlv = newId("dlv");
      ctx.db.run(
        `INSERT INTO deliveries (id, webhook_id, event_seq, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`,
        dlv,
        id,
        seq,
        ts,
        ts,
      );
      return dlv;
    });
    publishDelivery(deliveryId);
    await run(deliveryId);
    return deliveryById(ctx.db, deliveryId)!;
  }

  async function replay(deliveryId: string): Promise<Delivery> {
    const existing = deliveryById(ctx.db, deliveryId);
    if (!existing) throw notFound("Delivery");
    await inflight.get(deliveryId);
    const ts = now();
    ctx.db.run("UPDATE deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?", ts, ts, deliveryId);
    publishDelivery(deliveryId);
    await run(deliveryId);
    return deliveryById(ctx.db, deliveryId)!;
  }

  function prune(beforeIso: string): number {
    const n = ctx.db.tx(() => {
      const removed = ctx.db.run(
        `DELETE FROM deliveries WHERE updated_at < ? AND (status IN ('succeeded', 'dead') OR event_seq < 0)`,
        beforeIso,
      ).changes;
      deleteOrphanTestEvents();
      return removed;
    });
    return n;
  }

  // ───────────── Worker ─────────────

  function wake(): void {
    if (!timer || wakeQueued) return;
    wakeQueued = true;
    setImmediate(() => {
      wakeQueued = false;
      tick();
    });
  }

  function tick(): void {
    if (!timer) return;
    const capacity = concurrency - inflight.size;
    if (capacity <= 0) return;
    const busy = [...inflight.keys()];
    let due: { id: string }[];
    try {
      due = ctx.db.all<{ id: string }>(
        `SELECT d.id FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id JOIN agents a ON a.id = w.agent_id
         WHERE d.status IN ('pending', 'failed') AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
           AND w.enabled = 1 AND a.disabled = 0 ${busy.length ? `AND d.id NOT IN (${busy.map(() => "?").join(", ")})` : ""}
         ORDER BY d.next_attempt_at LIMIT ?`,
        now(),
        ...busy,
        capacity,
      );
    } catch (err) {
      log.error("Delivery worker query failed", { error: errorMessage(err) });
      return;
    }
    for (const d of due) void run(d.id);
  }

  /** One attempt per delivery at a time; the worker and manual replays share this. */
  function run(id: string): Promise<void> {
    const existing = inflight.get(id);
    if (existing) return existing;
    const p = attempt(id)
      .catch((err) => log.error("Delivery attempt failed", { delivery: id, error: errorMessage(err) }))
      .finally(() => {
        inflight.delete(id);
        wake();
      });
    inflight.set(id, p);
    return p;
  }

  async function attempt(id: string): Promise<void> {
    const d = ctx.db.get<AttemptRow>(
      `SELECT d.id, d.event_seq, d.attempts, w.url, w.secret_enc, w.include_body, w.agent_id
       FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?`,
      id,
    );
    if (!d) return;
    const isTest = d.event_seq < 0;
    const event = eventBySeq(ctx.db, d.event_seq);
    if (!event) return record(d, isTest, fail("The event was removed by retention before it could be delivered"), true);
    if (!isTest && !ctx.policy.canSeeEvent(d.agent_id, event)) {
      return record(d, isTest, fail("The webhook's agent can no longer see this event (grant or label scope changed)"), true);
    }

    const url = new URL(d.url);
    let target;
    try {
      target = await resolveTarget(url, ctx.settings.get().webhookAllowlist, options.lookup);
    } catch (err) {
      if (shutdown.signal.aborted) return;
      const hint = err instanceof SsrfError && err.hint ? ` ${err.hint}` : "";
      return record(d, isTest, fail(`${err instanceof SsrfError && err.kind === "blocked" ? "Blocked: " : ""}${errorMessage(err)}.${hint}`));
    }

    const body = JSON.stringify(await payload(event, bool(d.include_body), isTest));
    if (shutdown.signal.aborted) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      "content-type": "application/json",
      "user-agent": `agentinbox/${ctx.config.version}`,
      "webhook-id": d.id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": sign(ctx.crypto.decrypt(d.secret_enc), d.id, timestamp, body),
    };
    const result = await postPinned(url, target, headers, body, { timeoutMs, signal: shutdown.signal });
    // Shutting down mid-request: leave the row as it was so it's retried after restart.
    if (shutdown.signal.aborted) return;
    record(d, isTest, result);
  }

  async function payload(event: StoredEvent, includeBody: boolean, isTest: boolean): Promise<WebhookPayload> {
    const data: PayloadData = toMailEvent(event);
    if (includeBody && event.message) {
      if (isTest) data.content = TEST_CONTENT;
      else {
        try {
          data.content = await withTimeout(ctx.mail.messageContent(event.accountId, event.message.id), CONTENT_TIMEOUT_MS);
        } catch (err) {
          data.contentError = `Message body unavailable: ${errorMessage(err)}`.slice(0, 300);
        }
      }
    }
    return { type: event.type, timestamp: event.createdAt, data };
  }

  function record(d: AttemptRow, isTest: boolean, r: SendResult, final = false): void {
    const attempts = d.attempts + 1;
    const ok = r.error === null && r.statusCode !== null && r.statusCode >= 200 && r.statusCode < 300;
    let status: DeliveryStatus;
    let next: string | null = null;
    if (ok) status = "succeeded";
    // Test deliveries are one-shot: a failure is reported, not retried.
    else if (isTest) status = "failed";
    else if (final || attempts > schedule.length) status = "dead";
    else {
      status = "failed";
      next = new Date(Date.now() + schedule[attempts - 1]!).toISOString();
    }
    ctx.db.run(
      `UPDATE deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_status_code = ?, last_error = ?, last_response = ?,
       duration_ms = ?, updated_at = ? WHERE id = ?`,
      status,
      attempts,
      next,
      r.statusCode,
      r.error,
      r.response,
      r.durationMs,
      now(),
      d.id,
    );
    if (!ok) log.warn("Webhook delivery failed", { delivery: d.id, status, error: r.error });
    publishDelivery(d.id);
  }

  function publishDelivery(id: string): void {
    const delivery = deliveryById(ctx.db, id);
    if (!delivery) return;
    try {
      ctx.bus.emit("delivery", delivery);
    } catch (err) {
      log.error("Bus listener failed", { error: errorMessage(err) });
    }
  }

  const onEvent = () => wake();

  return {
    list,
    get,
    create,
    update,
    rotateSecret,
    remove,
    test,
    listDeliveries,
    replay,
    enqueue,
    prune,
    start() {
      if (timer) return;
      if (shutdown.signal.aborted) shutdown = new AbortController();
      timer = setInterval(tick, tickMs);
      timer.unref();
      ctx.bus.on("event", onEvent);
      wake();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      ctx.bus.off("event", onEvent);
      shutdown.abort();
      await Promise.allSettled([...inflight.values()]);
    },
  };
}

const fail = (error: string): SendResult => ({ statusCode: null, response: null, error, durationMs: 0 });

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw badRequest(z.prettifyError(r.error));
  return r.data;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}
