import { EventEmitter } from "node:events";
import type { Account, Approval, AuditEntry, Delivery, MailEvent, Settings } from "../shared/types.ts";

/**
 * In-process notifications. Fired *after* the change is committed to the database, so listeners
 * can read it back. Used by the console SSE stream, `wait_for_events`, the webhook worker and the
 * ingest loop (settings changes). Listeners must not throw.
 */
export interface BusEvents {
  /** A new event row was committed (and its webhook deliveries enqueued). */
  event: [MailEvent];
  /** A delivery was created or changed state. */
  delivery: [Delivery];
  /** An approval was created or decided. */
  approval: [Approval];
  audit: [AuditEntry];
  /** An account was connected or its status/sync state changed. */
  account: [Account];
  settings: [Settings];
}

export type Bus = EventEmitter<BusEvents>;

export function createBus(): Bus {
  const bus = new EventEmitter<BusEvents>();
  // Every SSE client and pending wait_for_events call adds a listener.
  bus.setMaxListeners(0);
  return bus;
}
