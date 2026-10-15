import { z } from "zod";
import type { Settings } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

/** Shape check only; ranges and URL rules are enforced by SettingsStore.update. */
const SettingsPatch = z
  .object({
    publicUrl: z.string().trim(),
    ingestMode: z.enum(["pubsub", "poll"]),
    pollIntervalSeconds: z.number(),
    maxBodyChars: z.number(),
    retentionDays: z.number(),
    approvalTtlHours: z.number(),
    webhookAllowlist: z.array(z.string()),
  })
  .partial()
  .strict() satisfies z.ZodType<Partial<Settings>>;

export function settingsApi(ctx: AppContext) {
  return router()
    .get("/settings", (c) => c.json<Settings>(ctx.settings.get()))
    .patch("/settings", async (c) => {
      const patch = await readBody(c, SettingsPatch);
      const before = ctx.settings.get();
      const next = ctx.settings.update(patch);
      const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
      if (changed.length) ctx.audit.record({ ...ADMIN_ACTOR, action: "settings.update", outcome: "ok", detail: { changed } });
      return c.json<Settings>(next);
    });
}
