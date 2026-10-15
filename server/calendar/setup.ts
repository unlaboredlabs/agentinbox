// "Add Google Calendar" state and probes (workstream D, docs/calendar.md "Setup and upgrade").

import type { CalendarSetupState } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { notImplemented } from "./todo.ts";
import type { CalendarService } from "./types.ts";

export type CalendarSetup = Pick<CalendarService, "setupState" | "updateSetup" | "check" | "calendars">;

/** Whether Calendar is part of this install (InternalState "calendar.setup"; no row = fresh install = enabled). */
export function calendarEnabled(ctx: Pick<AppContext, "settings">): boolean {
  return ctx.settings.getState("calendar.setup")?.enabled ?? true;
}

export function createCalendarSetup(_ctx: AppContext): CalendarSetup {
  return {
    setupState(): CalendarSetupState {
      throw notImplemented("setupState", "D");
    },
    updateSetup() {
      throw notImplemented("updateSetup", "D");
    },
    async check() {
      throw notImplemented("check", "D");
    },
    async calendars() {
      throw notImplemented("calendars", "D");
    },
  };
}
