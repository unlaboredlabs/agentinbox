import type { EventType, MailEvent, MessageSummary } from "../../shared/types.ts";
import { type Db, json } from "../db/index.ts";
import type { StoredEvent } from "./types.ts";

/**
 * Synthetic events created by `webhooks.test` are stored with a negative seq so their deliveries
 * can join them like any other event. Every agent- and console-facing query only reads seq > 0.
 */
export const TEST_ACCOUNT_ID = "acc_test";
export const TEST_ACCOUNT_EMAIL = "test@agentinbox.invalid";

export interface EventRow {
  seq: number;
  id: string;
  type: EventType;
  account_id: string;
  account_email: string | null;
  label_ids: string;
  message: string | null;
  changed_label_ids: string | null;
  detail: string | null;
  created_at: string;
}

/** Joins the account email live; deleted accounts fall back to detail.email. */
export const EVENT_SELECT = `SELECT e.seq, e.id, e.type, e.account_id, a.email AS account_email, e.label_ids, e.message,
  e.changed_label_ids, e.detail, e.created_at FROM events e LEFT JOIN accounts a ON a.id = e.account_id`;

export function toStoredEvent(r: EventRow): StoredEvent {
  const detail = json.parse<Record<string, unknown> | null>(r.detail, null);
  const changed = json.parse<string[] | null>(r.changed_label_ids, null);
  const fallbackEmail = r.seq < 0 ? TEST_ACCOUNT_EMAIL : typeof detail?.email === "string" ? detail.email : "";
  return {
    id: r.id,
    seq: r.seq,
    type: r.type,
    accountId: r.account_id,
    accountEmail: r.account_email ?? fallbackEmail,
    message: json.parse<MessageSummary | null>(r.message, null),
    ...(changed ? { labelIds: changed } : {}),
    ...(detail ? { detail } : {}),
    createdAt: r.created_at,
    threadLabelIds: json.parse<string[]>(r.label_ids, []),
  };
}

/** The public shape: drops the scope labels. */
export function toMailEvent(e: StoredEvent): MailEvent {
  const { threadLabelIds: _scope, ...pub } = e;
  return pub;
}

export function eventBySeq(db: Db, seq: number): StoredEvent | null {
  const row = db.get<EventRow>(`${EVENT_SELECT} WHERE e.seq = ?`, seq);
  return row ? toStoredEvent(row) : null;
}
