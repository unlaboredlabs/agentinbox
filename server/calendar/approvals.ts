// Applying calendar approvals (workstream B, docs/calendar.md "Approvals"). The approval state machine
// stays in server/mail/approvals.ts; it calls these for calendar.* kinds.

import type { AppContext } from "../context.ts";
import { notImplemented } from "./todo.ts";
import type { CalendarService } from "./types.ts";

export type CalendarApprovals = Pick<CalendarService, "approvalBlockedReason" | "applyApproval">;

export function createCalendarApprovals(_ctx: AppContext): CalendarApprovals {
  return {
    /**
     * Must re-check: agent exists and is enabled, grant still has calendar.write, the calendar is still in
     * calendarScope, every `calendar.notified` address still passes allowTo.
     */
    approvalBlockedReason() {
      throw notImplemented("approvalBlockedReason", "B");
    },
    /**
     * Applies `approval.calendar` with sendUpdates from notifyAttendees; update/delete use If-Match on the
     * etag seen when queued (412 → fail "the event changed in Google Calendar since"). Then ctx.calendar.kick.
     */
    async applyApproval() {
      throw notImplemented("applyApproval", "B");
    },
  };
}
