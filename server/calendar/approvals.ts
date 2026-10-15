// Applying calendar changes (workstream B, docs/calendar.md "Approvals"). The approval state machine stays
// in server/mail/approvals.ts; it calls these for calendar.* kinds. Direct-mode writes (AgentCalendar) go
// through the same applyChange, so both paths send exactly the same request to Google.

import { randomUUID } from "node:crypto";
import type { Approval, CalendarApprovalDetail, CalendarEventInput, CalendarResponseStatus } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import type { CalendarAttendeeRaw, CalendarClient, CalendarDateTimeRaw, CalendarEventRaw } from "../google/calendar.ts";
import { classifyCalendarError } from "../google/calendar.ts";
import { GoogleApiError } from "../google/types.ts";
import { attendeeImpact, calendarInScope, normalizeCalendarId } from "../policy/calendar.ts";
import { disallowedRecipients } from "../policy/enforce.ts";
import { selfAttendee } from "./summary.ts";
import type { CalendarService } from "./types.ts";

export type CalendarApprovals = Pick<CalendarService, "approvalBlockedReason" | "applyApproval">;

export type CalendarWriteKind = "create" | "update" | "delete" | "rsvp";

export const writeKindOf = (kind: Approval["kind"]): CalendarWriteKind | null =>
  kind === "calendar.create" ? "create" : kind === "calendar.update" ? "update" : kind === "calendar.delete" ? "delete" : kind === "calendar.rsvp" ? "rsvp" : null;

export const EVENT_CHANGED = "The event changed in Google Calendar since the change was prepared, so it was not applied.";
export const EVENT_GONE = "The event no longer exists in Google Calendar.";

const ALL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Start/end for Google; the other form is cleared so a patch can switch between timed and all-day. */
function when(value: string, timeZone: string | undefined): CalendarDateTimeRaw {
  if (ALL_DAY.test(value)) return { date: value, dateTime: null, timeZone: null } as unknown as CalendarDateTimeRaw;
  return { dateTime: value, date: null, ...(timeZone ? { timeZone } : {}) } as unknown as CalendarDateTimeRaw;
}

/**
 * The new attendee list: people already on the event keep their entry (response, optional flag), new ones
 * are added by email. The account's own entry is kept even when the list leaves it out.
 */
function mergeAttendees(existing: CalendarAttendeeRaw[], emails: string[]): CalendarAttendeeRaw[] {
  const byEmail = new Map(existing.filter((x) => x.email).map((x) => [x.email!.toLowerCase(), x]));
  const wanted = new Set(emails);
  return [...emails.map((e) => byEmail.get(e) ?? { email: e }), ...existing.filter((x) => x.self && !wanted.has(x.email?.toLowerCase() ?? ""))];
}

/** Google event resource for a create, or the changed fields for a patch (`current` = the event being changed). */
export function eventResource(change: CalendarEventInput, current: CalendarEventRaw | null): Partial<CalendarEventRaw> {
  const r: Partial<CalendarEventRaw> = {};
  if (change.summary !== undefined) r.summary = change.summary;
  if (change.description !== undefined) r.description = change.description;
  if (change.location !== undefined) r.location = change.location;
  if (change.start !== undefined) r.start = when(change.start, change.timeZone);
  if (change.end !== undefined) r.end = when(change.end, change.timeZone);
  if (change.attendees !== undefined) r.attendees = mergeAttendees(current?.attendees ?? [], change.attendees);
  if (change.recurrence !== undefined) r.recurrence = change.recurrence;
  if (change.addConference) r.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  return r;
}

/**
 * Sends one change to Google. `current` is the event as it is now (update: to keep existing attendees'
 * entries; rsvp: to find the account's own attendee entry). Update and delete send If-Match with the stored
 * etag (412 = changed since). A create uses the id chosen in advance; Google's 409 for an existing id means
 * an earlier attempt already created it. Returns the event after the change (null for delete).
 */
export async function applyChange(
  client: CalendarClient,
  kind: CalendarWriteKind,
  d: CalendarApprovalDetail & { eventId: string },
  current: CalendarEventRaw | null,
): Promise<CalendarEventRaw | null> {
  const sendUpdates = d.notifyAttendees ? "all" : "none";
  const conferenceDataVersion = d.change.addConference ? 1 : 0;
  switch (kind) {
    case "create":
      try {
        return await client.insertEvent(d.calendarId, { id: d.eventId, ...eventResource(d.change, null) }, { sendUpdates, conferenceDataVersion });
      } catch (err) {
        if (err instanceof GoogleApiError && err.status === 409) return client.getEvent(d.calendarId, d.eventId);
        throw err;
      }
    case "update":
      return client.patchEvent(d.calendarId, d.eventId, eventResource(d.change, current), { sendUpdates, conferenceDataVersion, ifMatchEtag: d.etag ?? undefined });
    case "delete":
      await client.deleteEvent(d.calendarId, d.eventId, { sendUpdates, ifMatchEtag: d.etag ?? undefined });
      return null;
    case "rsvp": {
      const self = current && selfAttendee(current);
      if (!self?.email) throw new Error("The account is no longer invited to this event.");
      const attendee: CalendarAttendeeRaw = { email: self.email, responseStatus: d.response as CalendarResponseStatus, ...(d.comment ? { comment: d.comment } : {}) };
      return client.patchEvent(d.calendarId, d.eventId, { attendees: [attendee], attendeesOmitted: true }, { sendUpdates });
    }
  }
}

/** Who the stored change involves (CalendarApprovalDetail.checked; recomputed for approvals stored without it). */
function checkedOf(kind: CalendarWriteKind, d: CalendarApprovalDetail, selfEmail: string): string[] {
  if (d.checked) return d.checked;
  const before = (d.before?.attendees ?? []).filter((x) => !x.self && !x.resource).map((x) => x.email);
  return attendeeImpact({
    kind,
    selfEmail,
    before,
    after: d.change.attendees ?? before,
    notify: d.notifyAttendees,
    organizer: d.before?.organizer?.email ?? null,
    organizerSelf: kind === "create" || !!d.before?.organizerSelf,
    comment: !!d.comment,
  }).checked;
}

/** Attendees `change` adds to an event that had `before` (the account and rooms excluded). */
export function addedAttendees(change: CalendarEventInput, before: string[], selfEmail: string): string[] {
  if (!change.attendees) return [];
  const had = new Set(before.map((x) => x.toLowerCase()));
  return attendeeImpact({ kind: "create", selfEmail, before: [], after: change.attendees, notify: false }).checked.filter((x) => !had.has(x));
}

/** The stored change, when it has everything its kind needs (else applying fails for good). */
function wellFormed(a: Approval): { kind: CalendarWriteKind; d: CalendarApprovalDetail & { eventId: string } } | null {
  const kind = writeKindOf(a.kind);
  const d = a.calendar;
  if (!kind || !d || typeof d.calendarId !== "string" || !d.calendarId || !d.change || typeof d.eventId !== "string" || !d.eventId) return null;
  if ((kind === "update" || kind === "delete") && !d.etag) return null;
  if (kind === "rsvp" && !["accepted", "declined", "tentative"].includes(d.response ?? "")) return null;
  return { kind, d: d as CalendarApprovalDetail & { eventId: string } };
}

export function createCalendarApprovals(ctx: AppContext): CalendarApprovals {
  const selfEmail = (a: Approval) => ctx.accounts.get(a.accountId)?.email ?? a.accountEmail;

  return {
    /**
     * The calendar rules under the agent's current grant (server/mail/approvals.ts checks first that the
     * agent still exists and is enabled): calendar.write, calendar scope, allowTo over everyone the change
     * involves, and replyOnly against new attendees. A malformed change isn't blocked here: applying fails.
     */
    approvalBlockedReason(a) {
      const grant = ctx.policy.grant(a.agentId, a.accountId);
      if (!grant || !grant.capabilities.includes("calendar.write")) return "the agent is no longer allowed to change calendars on this account";
      const ok = wellFormed(a);
      if (!ok) return null;
      const { kind, d } = ok;
      if (!calendarInScope(grant, d.calendarId)) return "the calendar is no longer in the agent's calendar scope";
      const bad = disallowedRecipients(grant, checkedOf(kind, d, selfEmail(a)));
      if (bad.length) return `the agent may no longer involve ${bad.join(", ")}`;
      if (grant.replyOnly && addedAttendees(d.change, (d.before?.attendees ?? []).map((x) => x.email), selfEmail(a)).length) return "the agent may now only reply on this account, not invite people";
      return null;
    },

    /**
     * Applies the stored change. Update re-reads the event first and fails when its etag moved (and sends
     * If-Match anyway, for a change in between); delete sends If-Match. Under a null calendar scope the
     * calendar must still be in the account's list. Transient Google errors are rethrown as they are (the
     * approval goes back to pending); anything else becomes a plain message and fails it.
     */
    async applyApproval(a) {
      const ok = wellFormed(a);
      if (!ok) throw new Error("This calendar request is incomplete and can't be applied.");
      const { kind, d } = ok;
      const client = ctx.google.calendar(a.accountId);
      try {
        const grant = ctx.policy.grant(a.agentId, a.accountId);
        if (grant?.calendarScope === null && normalizeCalendarId(d.calendarId) !== selfEmail(a).toLowerCase()) {
          const listed = await ctx.calendar.calendars(a.accountId);
          if (!listed.some((c) => normalizeCalendarId(c.id) === normalizeCalendarId(d.calendarId))) {
            throw new Error("The calendar is no longer in the account's calendar list.");
          }
        }
        let current: CalendarEventRaw | null = null;
        if (kind === "update" || kind === "rsvp") {
          current = await client.getEvent(d.calendarId, d.eventId);
          if (current.status === "cancelled") throw new Error(EVENT_GONE);
          if (kind === "update" && current.etag !== d.etag) throw new Error(EVENT_CHANGED);
        }
        await applyChange(client, kind, d, current);
      } catch (err) {
        throw explain(err);
      }
      ctx.calendar.kick(a.accountId, d.calendarId);
      return { eventId: d.eventId };
    },
  };
}

/** A Google failure that retrying won't fix, in words for the approval card; anything else unchanged. */
function explain(err: unknown): unknown {
  if (!(err instanceof GoogleApiError)) return err;
  const kind = classifyCalendarError(err);
  if (kind === "api_disabled") return new Error("The Google Calendar API is turned off in the Google Cloud project.");
  if (kind === "scope_missing") return new Error("The account no longer grants Google Calendar access.");
  if (err.status === 412) return new Error(EVENT_CHANGED);
  if (err.status === 404 || err.status === 410) return new Error(EVENT_GONE);
  return err;
}
