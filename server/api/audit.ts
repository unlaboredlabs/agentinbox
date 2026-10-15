import type { AuditOutcome } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { badRequest } from "../util/errors.ts";
import { cursorParam } from "../events/repo.ts";
import { router } from "./util.ts";

const OUTCOMES: AuditOutcome[] = ["ok", "denied", "error"];

/** Paths are relative to /api. */
export function auditApi(ctx: AppContext) {
  return router().get("/audit", (c) => {
    const q = c.req.query();
    if (q.outcome && !OUTCOMES.includes(q.outcome as AuditOutcome)) throw badRequest(`outcome must be one of ${OUTCOMES.join(", ")}`);
    const limit = Number(q.limit);
    return c.json(
      ctx.audit.list({
        agentId: q.agentId || undefined,
        accountId: q.accountId || undefined,
        outcome: (q.outcome as AuditOutcome) || undefined,
        action: q.action || undefined,
        cursor: cursorParam(q.cursor),
        limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
      }),
    );
  });
}
