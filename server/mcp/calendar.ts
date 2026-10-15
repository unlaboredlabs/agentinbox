// Google Calendar MCP tools (workstream C, docs/calendar.md "MCP tools"). Registered by buildMcpServer;
// each handler builds `new AgentCalendar(ctx, mail.principal, mail.trace)` (server/calendar/agent.ts, B)
// and formats its result. Event text (description, location, names) is untrusted: descriptions are wrapped
// like mail bodies and one-liners go through cleanLine.
//
// Tools (names in TOOL_NAMES):
//   calendar.read:  list_calendars, list_calendar_events, get_calendar_event, get_free_busy
//   calendar.write: create_calendar_event, update_calendar_event, delete_calendar_event, respond_to_invitation
//   get_send_status is also registered for calendar.write (approval ids from calendar writes).

import type { AppContext } from "../context.ts";
import type { Abilities, Register } from "./server.ts";

/** Registers the calendar tools this agent's grants allow. Contract stub: registers none until C lands. */
export function registerCalendarTools(_ctx: AppContext, _register: Register, _can: Abilities): void {}
