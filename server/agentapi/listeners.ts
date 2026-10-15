import type { ListenerInfo } from "../../shared/types.ts";
import { bool, type Db, json } from "../db/index.ts";
import { badRequest } from "../util/errors.ts";

const CONSUMER_RE = /^[\w.:@-]{1,64}$/;

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
  if (!CONSUMER_RE.test(consumer)) throw badRequest("consumer must be 1-64 letters, digits or . _ - : @");
  return consumer;
}

export const ackedSeq = (db: Db, agentId: string, consumer: string): number =>
  db.get<{ acked_seq: number }>("SELECT acked_seq FROM listener_cursors WHERE agent_id = ? AND consumer = ?", agentId, consumer)?.acked_seq ?? 0;

/** Moves the consumer's cursor forward only, and never past the newest event. */
export function ackListener(db: Db, agentId: string, consumer: string, seq: number): { ackedSeq: number } {
  const max = db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM events")?.m ?? 0;
  const target = Math.min(Math.max(0, Math.floor(seq)), Math.max(0, max));
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
