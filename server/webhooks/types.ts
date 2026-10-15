// Webhooks domain contract. Owned by the events + webhooks work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type { Delivery, DeliveryStatus, Page, Webhook, WebhookInput, WebhookWithSecret } from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";
import type { StoredEvent } from "../events/types.ts";

export interface WebhooksService extends Lifecycle {
  list(agentId?: string): Webhook[];
  get(id: string): Webhook | null;
  /** Validates the URL against the SSRF guard. */
  create(input: WebhookInput): WebhookWithSecret;
  update(id: string, patch: Partial<WebhookInput>): Webhook;
  rotateSecret(id: string): WebhookWithSecret;
  remove(id: string): void;
  /** Sends a synthetic event synchronously and returns the recorded delivery. */
  test(id: string): Promise<Delivery>;

  listDeliveries(q: { webhookId?: string; status?: DeliveryStatus; cursor?: string | null; limit?: number }): Page<Delivery>;
  /** Re-queues a delivery (any state) for immediate delivery. */
  replay(deliveryId: string): Promise<Delivery>;

  /**
   * FROZEN. Called by events.emit inside its transaction: inserts a pending delivery for every enabled
   * webhook whose type list, filter and agent visibility match. Returns how many were enqueued.
   */
  enqueue(event: StoredEvent): number;

  /** Deletes finished deliveries older than `beforeIso`. */
  prune(beforeIso: string): number;
}
