import { z } from "zod";
import type { DeliveryStatus } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { badRequest } from "../util/errors.ts";
import { cursorParam } from "../events/repo.ts";
import { webhookInputSchema, webhookPatchSchema } from "../webhooks/filter.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const DELIVERY_STATUSES: DeliveryStatus[] = ["pending", "succeeded", "failed", "dead"];

/** Paths are relative to /api. */
export function webhooksApi(ctx: AppContext) {
  const audit = (action: string, target: string, detail?: Record<string, unknown>) =>
    ctx.audit.record({ ...ADMIN_ACTOR, action, target, outcome: "ok", detail: detail ?? null });

  return router()
    .get("/webhooks", (c) => c.json(ctx.webhooks.list(c.req.query("agentId") || undefined)))
    .post("/webhooks", async (c) => {
      const input = await readBody(c, webhookInputSchema);
      const created = await ctx.webhooks.create(input);
      audit("webhook.create", created.webhook.id, describe(created.webhook));
      return c.json(created);
    })
    .patch("/webhooks/:id", async (c) => {
      const patch = await readBody(c, webhookPatchSchema);
      const webhook = await ctx.webhooks.update(c.req.param("id"), patch);
      audit("webhook.update", webhook.id, { ...describe(webhook), fields: Object.keys(patch) });
      return c.json(webhook);
    })
    .delete("/webhooks/:id", (c) => {
      const id = c.req.param("id");
      ctx.webhooks.remove(id);
      audit("webhook.delete", id);
      return c.body(null, 204);
    })
    .post("/webhooks/:id/rotate-secret", (c) => {
      const rotated = ctx.webhooks.rotateSecret(c.req.param("id"));
      audit("webhook.rotate_secret", rotated.webhook.id, describe(rotated.webhook));
      return c.json(rotated);
    })
    .post("/webhooks/:id/test", async (c) => {
      const delivery = await ctx.webhooks.test(c.req.param("id"));
      audit("webhook.test", delivery.webhookId, { delivery: delivery.id, status: delivery.status, statusCode: delivery.lastStatusCode });
      return c.json(delivery);
    })
    .get("/deliveries", (c) => {
      const status = c.req.query("status");
      if (status && !DELIVERY_STATUSES.includes(status as DeliveryStatus)) throw badRequest(`status must be one of ${DELIVERY_STATUSES.join(", ")}`);
      const limit = z.coerce.number().int().optional().safeParse(c.req.query("limit") || undefined);
      return c.json(
        ctx.webhooks.listDeliveries({
          webhookId: c.req.query("webhookId") || undefined,
          status: (status as DeliveryStatus) || undefined,
          cursor: cursorParam(c.req.query("cursor")),
          limit: limit.success ? limit.data : undefined,
        }),
      );
    })
    .post("/deliveries/:id/replay", async (c) => {
      const delivery = await ctx.webhooks.replay(c.req.param("id"));
      audit("delivery.replay", delivery.id, { webhook: delivery.webhookId, status: delivery.status, statusCode: delivery.lastStatusCode });
      return c.json(delivery);
    });
}

/** Never the full URL: query strings sometimes carry tokens. */
function describe(w: { name: string; url: string; agentId: string }): Record<string, unknown> {
  return { name: w.name, host: new URL(w.url).host, agentId: w.agentId };
}
