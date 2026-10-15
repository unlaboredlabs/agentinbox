// Calendar sync engine (workstream A, docs/calendar.md "Sync"). Polls events.list with syncToken per synced
// calendar, turns changes into calendar.* events via ctx.events.emit, keeps calendar_sync and
// calendar_event_state up to date and records account calendar status (accounts.calendar_*).

import type { AppContext } from "../context.ts";
import { notImplemented } from "./todo.ts";
import type { CalendarService } from "./types.ts";

export type CalendarSync = Pick<CalendarService, "kick" | "syncAccount" | "start" | "stop">;

/**
 * Contract stub: start/stop/kick are no-ops so the app runs (mail-only) until A lands; syncAccount throws.
 * A replaces this with the real engine (timers honor Settings.calendarPollSeconds; push-verified calendars
 * poll every 15 minutes).
 */
export function createCalendarSync(_ctx: AppContext): CalendarSync {
  return {
    kick() {},
    async syncAccount() {
      throw notImplemented("syncAccount", "A");
    },
  };
}
