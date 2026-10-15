// Optional Calendar push channels (workstream D, docs/calendar.md "Push"). Only when publicUrl is public
// https; polling stays on as the safety net. Channels live in calendar_sync.channel_*.

import type { AppContext } from "../context.ts";
import type { CalendarService } from "./types.ts";

/** Path Google posts channel notifications to (mounted unauthenticated in server/app.ts). */
export const CALENDAR_PUSH_PATH = "/google/calendar/push";

export type CalendarPush = Pick<CalendarService, "handlePush"> & {
  /** Creates/renews/stops channels to match the synced calendars and the current publicUrl. Never throws. */
  reconcile(accountId?: string): Promise<void>;
};

/** Contract stub: push is off (404 tells Google to stop sending). */
export function createCalendarPush(_ctx: AppContext): CalendarPush {
  return {
    handlePush: () => 404,
    async reconcile() {},
  };
}
