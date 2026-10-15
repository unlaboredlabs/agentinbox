import type { ListenerInfo } from "../../shared/types.ts";
import { bool, type Db, json } from "../db/index.ts";
import type { AppContext } from "../context.ts";
import { EVENT_SELECT, type EventRow, toStoredEvent } from "../events/repo.ts";
import { badRequest, HttpError } from "../util/errors.ts";

const CONSUMER_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Why a live stream must end, or null while the key, agent and a read grant are all still valid. */
export type RevokeReason = "agent_deleted" | "agent_disabled" | "key_rotated" | "no_read_grant";

export function accessProblem(db: Db, agentId: string, keyHash: string): RevokeReason | null {
  const a = db.get<{ key_hash: string; disabled: number }>("SELECT key_hash, disabled FROM agents WHERE id = ?", agentId);
  if (!a) return "agent_deleted";
  if (a.key_hash !== keyHash) return "key_rotated";
  if (bool(a.disabled)) return "agent_disabled";
  const grants = db.all<{ capabilities: string }>("SELECT capabilities FROM grants WHERE agent_id = ?", agentId);
  if (!grants.some((g) => json.parse<string[]>(g.capabilities, []).includes("read"))) return "no_read_grant";
  return null;
}

/** `ListenerInfo[]` for an agent, from listener_cursors. */
export function listenersOf(db: Db, agentId: string): ListenerInfo[] {
  return db
    .all<{ consumer: string; acked_seq: number; client: string; connected: number; last_seen_at: string | null }>(
      "SELECT consumer, acked_seq, client, connected, last_seen_at FROM listener_cursors WHERE agent_id = ? ORDER BY consumer",
      agentId,
    )
    .map((r) => ({ consumer: r.consumer, connected: r.connected > 0, ackedSeq: r.acked_seq, lastSeenAt: r.last_seen_at, client: json.parse(r.client, {}) }));
}

export function parseConsumer(raw: unknown): string {
  const consumer = raw === undefined || raw === "" ? "default" : String(raw);
  if (!CONSUMER_RE.test(consumer)) throw badRequest("consumer must be 1-100 letters, digits, dots, underscores or dashes");
  return consumer;
}

export const ackedSeq = (db: Db, agentId: string, consumer: string): number =>
  db.get<{ acked_seq: number }>("SELECT acked_seq FROM listener_cursors WHERE agent_id = ? AND consumer = ?", agentId, consumer)?.acked_seq ?? 0;

/** Rows examined when looking for the newest event an agent can see. */
const VISIBLE_SCAN_MAX = 2000;

/**
 * Cursor cap: the newest event seq in the accounts this agent can read (one indexed lookup per
 * account, no label check). Capping acks, `after` and Last-Event-ID there means a client can't skip
 * future events by acking ahead, and only learns seqs of accounts it already reads. Anything between
 * the newest visible event and this cap is invisible to the agent, so a new consumer starts here too.
 */
export function newestGrantedSeq(ctx: AppContext, agentId: string): number {
  let max = 0;
  for (const g of ctx.policy.grants(agentId)) {
    if (!g.capabilities.includes("read")) continue;
    const r = ctx.db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM events WHERE account_id = ? AND seq > 0", g.accountId);
    max = Math.max(max, r?.m ?? 0);
  }
  return max;
}

/**
 * The newest event seq this agent may actually see (label scope included), or 0 if none: reported
 * as /me `headSeq`. When the scan budget runs out (narrow scope on a busy mailbox), the newest
 * granted seq stands in: everything scanned was invisible, so nothing visible lies above it.
 */
export function newestVisibleSeq(ctx: AppContext, agentId: string): number {
  const accounts = ctx.policy
    .grants(agentId)
    .filter((g) => g.capabilities.includes("read"))
    .map((g) => g.accountId);
  if (!accounts.length) return 0;
  const sql = `${EVENT_SELECT} WHERE e.seq > 0 AND e.seq < ? AND e.account_id IN (${accounts.map(() => "?").join(", ")}) ORDER BY e.seq DESC LIMIT 200`;
  let before = Number.MAX_SAFE_INTEGER;
  for (let scanned = 0; ; ) {
    if (scanned >= VISIBLE_SCAN_MAX) return newestGrantedSeq(ctx, agentId);
    const rows = ctx.db.all<EventRow>(sql, before, ...accounts);
    for (const r of rows) {
      const ev = toStoredEvent(r);
      if (ctx.policy.canSeeEvent(agentId, ev)) return ev.seq;
      before = r.seq;
    }
    scanned += rows.length;
    if (rows.length < 200) break;
  }
  return 0;
}

/**
 * Makes room for a new consumer: at most `max` per agent. The longest-idle disconnected consumer is
 * dropped only if it hasn't been seen within the retention window (its cursor is stale anyway);
 * otherwise 409, so a listener that reconnects later never silently restarts at the head.
 */
export function ensureConsumerSlot(ctx: AppContext, agentId: string, consumer: string, max: number): void {
  const { db } = ctx;
  if (db.get("SELECT 1 FROM listener_cursors WHERE agent_id = ? AND consumer = ?", agentId, consumer)) return;
  const { n } = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM listener_cursors WHERE agent_id = ?", agentId)!;
  if (n < max) return;
  const staleBefore = new Date(Date.now() - ctx.settings.get().retentionDays * 86_400_000).toISOString();
  const idle = db.get<{ consumer: string }>(
    `SELECT consumer FROM listener_cursors WHERE agent_id = ? AND connected = 0 AND COALESCE(last_seen_at, updated_at) < ?
     ORDER BY COALESCE(last_seen_at, updated_at) ASC LIMIT 1`,
    agentId,
    staleBefore,
  );
  if (!idle) {
    throw new HttpError(
      409,
      "too_many_consumers",
      `This agent already has ${max} listener consumers`,
      "Reuse an existing consumer name. Unused consumers are freed once they haven't connected for the retention period.",
    );
  }
  db.run("DELETE FROM listener_cursors WHERE agent_id = ? AND consumer = ?", agentId, idle.consumer);
}

/** Moves the consumer's cursor forward only, and never past the newest event in its granted accounts. */
export function ackListener(ctx: AppContext, agentId: string, consumer: string, seq: number, maxConsumers: number): { ackedSeq: number } {
  const { db } = ctx;
  ensureConsumerSlot(ctx, agentId, consumer, maxConsumers);
  const target = Math.min(Math.max(0, Math.floor(seq)), newestGrantedSeq(ctx, agentId));
  const t = new Date().toISOString();
  db.run(
    `INSERT INTO listener_cursors (agent_id, consumer, acked_seq, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_id, consumer) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq), updated_at = excluded.updated_at`,
    agentId,
    consumer,
    target,
    t,
  );
  return { ackedSeq: ackedSeq(db, agentId, consumer) };
}
