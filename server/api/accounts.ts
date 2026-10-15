import { z } from "zod";
import type { Account } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { asHttpError } from "../google/http.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const ConnectInput = z.object({
  reauthAccountId: z.string().min(1).optional(),
  /** ["pubsub"]: incremental consent for Pub/Sub on the provisioning account (default: the account provisioning uses). */
  scopes: z.array(z.enum(["pubsub"])).optional(),
});
const CompleteInput = z.object({ url: z.string().trim().min(1, "Paste the URL you landed on after approving access") });

const google = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw asHttpError(err);
  }
};

/** /accounts: list, connect (direct + paste), resync, pause/resume, remove, labels. */
export function accountsApi(ctx: AppContext) {
  const r = router();
  const audited = (action: string, a: Account) =>
    ctx.audit.record({ ...ADMIN_ACTOR, action, accountId: a.id, outcome: "ok", detail: { email: a.email } });

  r.get("/accounts", (c) => c.json(ctx.accounts.list()));

  r.post("/accounts/connect", async (c) => {
    const { reauthAccountId, scopes } = await readBody(c, ConnectInput);
    return c.json(ctx.google.startConnect({ reauthAccountId, scopes }));
  });

  r.post("/accounts/connect/complete", async (c) => {
    const { url } = await readBody(c, CompleteInput);
    return c.json(await google(() => ctx.google.completeConnectFromUrl(url)));
  });

  r.post("/accounts/:id/resync", async (c) => {
    const account = await google(() => ctx.ingest.resync(c.req.param("id")));
    audited("account.resync", account);
    return c.json(account);
  });

  r.post("/accounts/:id/pause", async (c) => {
    const account = await google(() => ctx.ingest.pause(c.req.param("id")));
    audited("account.pause", account);
    return c.json(account);
  });

  r.post("/accounts/:id/resume", async (c) => {
    const account = await google(() => ctx.ingest.resume(c.req.param("id")));
    audited("account.resume", account);
    return c.json(account);
  });

  // Audited inside accounts.remove.
  r.delete("/accounts/:id", async (c) => {
    await ctx.accounts.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/accounts/:id/labels", async (c) => {
    const id = ctx.accounts.require(c.req.param("id")).id;
    return c.json(await google(() => ctx.google.labels(id)));
  });

  return r;
}
