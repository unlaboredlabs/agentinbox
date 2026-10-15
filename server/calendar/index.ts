// Google Calendar service: composes the per-workstream parts (docs/calendar.md). Each part lives in its
// own file with one owner; this file only wires them.

import type { AppContext } from "../context.ts";
import { createCalendarApprovals } from "./approvals.ts";
import { eventContent } from "./content.ts";
import { createCalendarPush } from "./push.ts";
import { createCalendarSetup } from "./setup.ts";
import { createCalendarSync } from "./sync.ts";
import type { CalendarService } from "./types.ts";

export function createCalendarService(ctx: AppContext): CalendarService {
  const push = createCalendarPush(ctx);
  // Push channels follow the set of synced calendars.
  const sync = createCalendarSync(ctx, { onSyncSetChanged: (accountId) => void push.reconcile(accountId) });
  const setup = createCalendarSetup(ctx);
  const approvals = createCalendarApprovals(ctx);
  return {
    kick: (accountId, calendarId) => sync.kick(accountId, calendarId),
    syncAccount: (accountId) => sync.syncAccount(accountId),
    setupState: () => setup.setupState(),
    updateSetup: (input) => setup.updateSetup(input),
    check: () => setup.check(),
    calendars: (accountId) => setup.calendars(accountId),
    handlePush: (headers) => push.handlePush(headers),
    approvalBlockedReason: (a) => approvals.approvalBlockedReason(a),
    applyApproval: (a) => approvals.applyApproval(a),
    eventContent: (accountId, calendarId, eventId) => eventContent(ctx, accountId, calendarId, eventId),
    async start() {
      await sync.start?.();
      void push.reconcile();
    },
    async stop() {
      await sync.stop?.();
    },
  };
}
