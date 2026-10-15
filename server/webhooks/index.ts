import type { AppContext } from "../context.ts";
import { stubService } from "../util/stub.ts";
import type { WebhooksService } from "./types.ts";

// PLACEHOLDER: replaced by the owning work area.
export function createWebhooksService(_ctx: AppContext): WebhooksService {
  return stubService<WebhooksService>("webhooks");
}
