import type { Delivery, DeliveryStatus, EventType } from "../../shared/types.ts";
import type { Db } from "../db/index.ts";

export interface DeliveryRow {
  rid: number;
  id: string;
  webhook_id: string;
  event_seq: number;
  event_id: string | null;
  event_type: EventType | null;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  last_response: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

/** The event may have been pruned by retention; the delivery row still renders. */
export const DELIVERY_SELECT = `SELECT d.rowid AS rid, d.*, e.id AS event_id, e.type AS event_type
  FROM deliveries d LEFT JOIN events e ON e.seq = d.event_seq`;

export const toDelivery = (r: DeliveryRow): Delivery => ({
  id: r.id,
  webhookId: r.webhook_id,
  eventId: r.event_id ?? "",
  eventType: r.event_type ?? "message.received",
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastStatusCode: r.last_status_code,
  lastError: r.last_error,
  lastResponse: r.last_response,
  durationMs: r.duration_ms,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function deliveryById(db: Db, id: string): Delivery | null {
  const row = db.get<DeliveryRow>(`${DELIVERY_SELECT} WHERE d.id = ?`, id);
  return row ? toDelivery(row) : null;
}

export function deliveriesForEvent(db: Db, seq: number): Delivery[] {
  return db.all<DeliveryRow>(`${DELIVERY_SELECT} WHERE d.event_seq = ? ORDER BY d.rowid`, seq).map(toDelivery);
}
