import type { PairingStatus } from "../../shared/types.ts";
import { agentApi } from "../agentapi/index.ts";
import { approveSchema, denySchema, PAIRING_STATUSES } from "../agentapi/pairing.ts";
import type { AppContext } from "../context.ts";
import { badRequest } from "../util/errors.ts";
import { readBody, router } from "./util.ts";

/** Device-flow pairing requests in the approvals inbox. Paths are relative to /api. */
export function pairingsApi(ctx: AppContext) {
  const pairings = () => agentApi(ctx).pairings;
  return router()
    .get("/pairings", (c) => {
      const status = c.req.query("status") || undefined;
      if (status && !PAIRING_STATUSES.includes(status as PairingStatus)) throw badRequest(`status must be one of ${PAIRING_STATUSES.join(", ")}`);
      return c.json(pairings().list(status as PairingStatus | undefined));
    })
    // The key goes to the polling CLI, never to the console.
    .post("/pairings/:id/approve", async (c) => c.json(pairings().approve(c.req.param("id"), await readBody(c, approveSchema))))
    .post("/pairings/:id/deny", async (c) => {
      const { note } = await readBody(c, denySchema);
      return c.json(pairings().deny(c.req.param("id"), note));
    });
}
