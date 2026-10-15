// Webhooks domain contract. Owned by the events + webhooks work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type { Delivery, DeliveryStatus, Page, Webhook, WebhookInput, WebhookWithSecret } from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";
import type { StoredEvent } from "../events/types.ts";

export interface WebhooksService extends Lifecycle {
  list(agentId?: string): Webhook[];
  get(id: string): Webhook | null;
  /** Validates the input and checks the URL against the SSRF guard (resolving its host). Throws HttpError(400). */
  create(input: WebhookInput): Promise<WebhookWithSecret>;
  /** Re-checks the URL against the SSRF guard when it changes. Throws HttpError(400/404). */
  update(id: string, patch: Partial<WebhookInput>): Promise<Webhook>;
  rotateSecret(id: string): WebhookWithSecret;
  remove(id: string): void;
  /**
   * Sends a synthetic message.received event (detail.test = true) synchronously and returns the
   * recorded delivery. The synthetic event is stored with a negative seq: it never shows up in
   * agent feeds, the console event list or the bus, and its delivery is not retried.
   */
  test(id: string): Promise<Delivery>;

  listDeliveries(q: { webhookId?: string; status?: DeliveryStatus; cursor?: string | null; limit?: number }): Page<Delivery>;
  /**
   * Re-queues a delivery (any state) and attempts it right away; resolves with the outcome. `attempts`
   * keeps counting, so a replayed delivery that already used up the retry schedule goes back to dead
   * if this attempt fails.
   */
  replay(deliveryId: string): Promise<Delivery>;

  /**
   * FROZEN. Called by events.emit inside its transaction: inserts a pending delivery for every enabled
   * webhook whose type list, filter and agent visibility match. Returns how many were enqueued.
   */
  enqueue(event: StoredEvent): number;

  /** Deletes finished deliveries older than `beforeIso`. */
  prune(beforeIso: string): number;
}
