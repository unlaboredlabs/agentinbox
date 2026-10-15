import { z } from "zod";
import type { ApprovalStatus } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { badRequest, notFound } from "../util/errors.ts";
import { readBody, router } from "./util.ts";

const STATUSES: ApprovalStatus[] = ["pending", "approved", "rejected", "sent", "failed", "expired"];
const decisionSchema = z.object({ note: z.string().max(2000).nullable().optional() });

export function approvalsApi(ctx: AppContext) {
  const app = router();

  app.get("/approvals", (c) => {
    const status = c.req.query("status") || undefined;
    if (status && !STATUSES.includes(status as ApprovalStatus)) throw badRequest(`status must be one of ${STATUSES.join(", ")}`);
    return c.json(ctx.mail.listApprovals(status as ApprovalStatus | undefined));
  });

  app.get("/approvals/:id", (c) => {
    const approval = ctx.mail.getApproval(c.req.param("id"));
    if (!approval) throw notFound("Approval");
    return c.json(approval);
  });

  app.post("/approvals/:id/approve", async (c) => {
    const { note } = await readBody(c, decisionSchema);
    return c.json(await ctx.mail.approve(c.req.param("id"), note));
  });

  app.post("/approvals/:id/reject", async (c) => {
    const { note } = await readBody(c, decisionSchema);
    return c.json(await ctx.mail.reject(c.req.param("id"), note));
  });

  return app;
}
