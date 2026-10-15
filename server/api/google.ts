import { z } from "zod";
import type { AppContext } from "../context.ts";
import { asHttpError } from "../google/http.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const ClientInput = z.object({
  clientId: z.string().trim().min(1, "Client ID is required"),
  clientSecret: z.string().optional(),
  projectId: z.string().trim().default(""),
  appType: z.enum(["internal", "external"]),
});

/** GET/PUT /google/client, POST /google/pubsub/provision, POST /google/pubsub/test. */
export function googleApi(ctx: AppContext) {
  const r = router();

  r.get("/google/client", (c) => c.json(ctx.google.clientView()));

  r.put("/google/client", async (c) => {
    const input = await readBody(c, ClientInput);
    const view = ctx.google.setClient(input);
    ctx.audit.record({
      ...ADMIN_ACTOR,
      action: "google.client.update",
      outcome: "ok",
      detail: { clientId: view.clientId, projectId: view.projectId, appType: view.appType, secretChanged: Boolean(input.clientSecret?.trim()) },
    });
    return c.json(view);
  });

  r.post("/google/pubsub/provision", async (c) => {
    try {
      const state = await ctx.google.provisionPubsub();
      ctx.audit.record({ ...ADMIN_ACTOR, action: "pubsub.provision", outcome: "ok", detail: { topic: state.topic, subscription: state.subscription } });
      return c.json(state);
    } catch (err) {
      const e = asHttpError(err);
      ctx.audit.record({
        ...ADMIN_ACTOR,
        action: "pubsub.provision",
        outcome: "error",
        detail: { error: e instanceof Error ? e.message : String(e) },
      });
      throw e;
    }
  });

  r.post("/google/pubsub/test", async (c) => {
    try {
      const result = await ctx.google.testPubsub();
      ctx.audit.record({ ...ADMIN_ACTOR, action: "pubsub.test", outcome: result.ok ? "ok" : "error", detail: { message: result.message } });
      return c.json(result);
    } catch (err) {
      throw asHttpError(err);
    }
  });

  return r;
}
