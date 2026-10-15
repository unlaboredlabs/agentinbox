// Agent-facing calendar actions (workstream B, docs/calendar.md "Grants and policy"). Like AgentMail: each
// method resolves the agent's grant, enforces capabilities, calendar scope, write mode, attendee allowTo
// and send caps, and returns structured data that server/mcp/calendar.ts (C) formats. Denials throw
// PolicyDenied (audited as "denied" with the reason); fixable input problems throw ToolError.

import type {
  Account,
  CalendarCapability,
  CalendarEventInput,
  CalendarEventSummary,
  CalendarInfo,
  CalendarResponseStatus,
  Grant,
  MessageContent,
} from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import type { CalendarClient } from "../google/calendar.ts";
import type { ToolTrace } from "../mail/agent.ts";
import type { AgentPrincipal } from "../policy/types.ts";
import { notImplemented } from "./todo.ts";

export interface CalendarAccess {
  grant: Grant;
  account: Account;
  calendar: CalendarClient;
}

/** Options every write takes. */
export interface WriteArgs {
  /** sendUpdates "all" (true, default) or "none". RSVP: whether the organizer is told. */
  notifyAttendees?: boolean;
  /** Shown to the human when the write needs approval. */
  reason?: string;
}

export type CalendarWriteOutcome =
  | { status: "applied"; event: CalendarEventSummary; notified: string[] }
  | { status: "deleted"; calendarId: string; eventId: string; notified: string[] }
  | { status: "pending_approval"; approvalId: string; expiresAt: string; message: string };

export class AgentCalendar {
  constructor(
    protected readonly ctx: AppContext,
    readonly principal: AgentPrincipal,
    readonly trace: ToolTrace = { detail: {} },
  ) {}

  /** Grants with any calendar capability, joined with their accounts. */
  accessible(): { grant: Grant; account: Account }[] {
    throw notImplemented("AgentCalendar.accessible", "B");
  }

  /**
   * Picks the account (email or id; optional when exactly one qualifies) and checks `cap`. Sets
   * trace.accountId. ToolError calendar_not_granted / needs_reauth when the account can't serve calendar calls.
   */
  resolve(_account: string | undefined, _cap: CalendarCapability): CalendarAccess {
    throw notImplemented("AgentCalendar.resolve", "B");
  }

  /**
   * The calendar id to act on: "primary" and omission mean the account's primary calendar when it is in
   * scope (else the only calendar in scope, else ToolError calendar_required). Out of scope → PolicyDenied
   * calendar_scope (message never reveals whether it exists).
   */
  calendarFor(_a: CalendarAccess, _calendarId: string | undefined): string {
    throw notImplemented("AgentCalendar.calendarFor", "B");
  }

  /** Calendars in the grant's scope. */
  listCalendars(_account: string | undefined): Promise<{ account: Account; calendars: CalendarInfo[] }> {
    throw notImplemented("AgentCalendar.listCalendars", "B");
  }

  /** Events overlapping [timeMin, timeMax) (singleEvents, ordered by start), optional free-text query. */
  listEvents(
    _account: string | undefined,
    _p: { calendarId?: string; timeMin: string; timeMax: string; query?: string; maxResults?: number; pageToken?: string },
  ): Promise<{ account: Account; calendarId: string; events: CalendarEventSummary[]; nextPageToken: string | null; timeZone: string | null }> {
    throw notImplemented("AgentCalendar.listEvents", "B");
  }

  /** One event plus its cleaned description (server/calendar/content.ts). */
  getEvent(
    _account: string | undefined,
    _calendarId: string | undefined,
    _eventId: string,
  ): Promise<{ account: Account; event: CalendarEventSummary; content: MessageContent | null }> {
    throw notImplemented("AgentCalendar.getEvent", "B");
  }

  /**
   * Busy intervals. `calendars` default to the in-scope calendars; with a null calendar scope any calendar id
   * or address may be asked (Google decides what the user can see), otherwise only in-scope ids.
   */
  freeBusy(
    _account: string | undefined,
    _p: { timeMin: string; timeMax: string; calendars?: string[] },
  ): Promise<{ account: Account; calendars: { id: string; busy: { start: string; end: string }[]; error: string | null }[] }> {
    throw notImplemented("AgentCalendar.freeBusy", "B");
  }

  createEvent(_account: string | undefined, _calendarId: string | undefined, _input: CalendarEventInput, _opts: WriteArgs): Promise<CalendarWriteOutcome> {
    throw notImplemented("AgentCalendar.createEvent", "B");
  }

  /** `change` holds only the fields to change; attendees, when given, is the full new list. */
  updateEvent(
    _account: string | undefined,
    _calendarId: string | undefined,
    _eventId: string,
    _change: CalendarEventInput,
    _opts: WriteArgs,
  ): Promise<CalendarWriteOutcome> {
    throw notImplemented("AgentCalendar.updateEvent", "B");
  }

  deleteEvent(_account: string | undefined, _calendarId: string | undefined, _eventId: string, _opts: WriteArgs): Promise<CalendarWriteOutcome> {
    throw notImplemented("AgentCalendar.deleteEvent", "B");
  }

  /** RSVP on an event the account is invited to (not its own). No allowTo check: the organizer invited it. */
  respond(
    _account: string | undefined,
    _calendarId: string | undefined,
    _eventId: string,
    _response: Exclude<CalendarResponseStatus, "needsAction">,
    _opts: WriteArgs & { comment?: string },
  ): Promise<CalendarWriteOutcome> {
    throw notImplemented("AgentCalendar.respond", "B");
  }
}
