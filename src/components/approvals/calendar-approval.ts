// Pure (relative imports only, no React): what a calendar approval will do, in words the human decides
// on. Unit tests load it. Approval-mode calendar writes are the brake on agent-written invitations, so
// everything Google will show or send is spelled out: place, description, every guest and every address
// that gets an email.

import type { Approval, CalendarApprovalDetail, CalendarApprovalKind, CalendarEventSummary } from "../../../shared/types.ts";
import { fmtAddressShort, fmtEventWhen } from "../../lib/format.ts";
import { CALENDAR_RESPONSE_LABEL } from "../../lib/labels.ts";

export type CalendarApproval = Approval & { kind: CalendarApprovalKind; calendar: CalendarApprovalDetail };

export const isCalendarApproval = (a: Approval): a is CalendarApproval => !!a.calendar && a.kind.startsWith("calendar.");

/** One line of the event as it is now (`before`) and as it will be (`after`); null = not set. */
export interface CalendarApprovalRow {
  label: string;
  before: string | null;
  after: string | null;
  changed: boolean;
}

export interface CalendarApprovalView {
  /** "Work" or the calendar id when the name is unknown. */
  calendar: string;
  title: string;
  /** What applying does, one sentence each. */
  effects: string[];
  rows: CalendarApprovalRow[];
  /** The description the agent wrote (create/update), shown in full; null when it isn't set or changed. */
  description: string | null;
  /** Everyone on the event after the change (they see it on their calendars), complete. */
  guests: string[];
  /** Guests beyond the 50 Google returned with the event (`before.attendeeCount`), not listed. */
  moreGuests: number;
  /** Every address Google will email on apply. */
  emailed: string[];
  /** RSVP only: the comment sent to the organizer. */
  comment: string | null;
}

const VERB: Record<CalendarApprovalKind, string> = {
  "calendar.create": "wants to add an event to",
  "calendar.update": "wants to change an event on",
  "calendar.delete": "wants to delete an event from",
  "calendar.rsvp": "wants to answer an invitation on",
};

/** Follows the agent's name in the approval header: "wants to change an event on <calendar>". */
export const calendarVerb = (a: Pick<CalendarApproval, "kind">) => VERB[a.kind];

const CHANGE_WORD: Record<string, string> = { Title: "the title", When: "the time", Where: "the place", "Video call": "the video call", Repeats: "the repeat rule" };
const quote = (s: string) => `“${s}”`;
const yesNo = (b: boolean | undefined) => (b ? "Yes" : null);
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

type When = { start: string; end: string; allDay: boolean };
const when = (w: Partial<When>, fmt: FormatOptions) => (w.start ? fmtEventWhen({ start: w.start, end: w.end ?? w.start, allDay: !!w.allDay }, fmt) : null);
const guestsOf = (e: CalendarEventSummary | null) => (e ? e.attendees.filter((x) => !x.resource).map((x) => x.email) : []);
const repeats = (r: string[] | undefined) => (r?.length ? r.join("; ") : null);

export interface FormatOptions {
  timeZone?: string;
  locale?: string;
  now?: number;
}

export function calendarApprovalView(a: CalendarApproval, fmt: FormatOptions = {}): CalendarApprovalView {
  const c = a.calendar;
  const ch = c.change;
  const b = c.before;
  const calendar = c.calendarName || c.calendarId;
  const title = ch.summary ?? b?.summary ?? a.subject ?? "";
  const named = title ? quote(title) : "an untitled event";
  const effects: string[] = [];
  const rows: CalendarApprovalRow[] = [];
  let guests: string[] = [];
  let description: string | null = null;

  if (a.kind === "calendar.rsvp") {
    effects.push(`Answers ${quote(CALENDAR_RESPONSE_LABEL[c.response ?? "accepted"])} to ${named}${b?.organizer ? `, organized by ${fmtAddressShort(b.organizer)}` : ""}.`);
    rows.push(
      { label: "Event", before: b?.summary ?? null, after: b?.summary ?? null, changed: false },
      { label: "When", before: b ? when(b, fmt) : null, after: b ? when(b, fmt) : null, changed: false },
      { label: "Your answer", before: b?.selfResponse ? CALENDAR_RESPONSE_LABEL[b.selfResponse] : null, after: c.response ? CALENDAR_RESPONSE_LABEL[c.response] : null, changed: true },
    );
    guests = guestsOf(b);
  } else if (a.kind === "calendar.delete") {
    effects.push(`Deletes ${named} from ${calendar}${b?.recurring ? ", every occurrence of the series" : ""}.`);
    rows.push(
      { label: "Title", before: b?.summary ?? null, after: null, changed: true },
      { label: "When", before: b ? when(b, fmt) : null, after: null, changed: true },
      { label: "Where", before: b?.location ?? null, after: null, changed: true },
    );
    guests = guestsOf(b);
  } else {
    const fields: { label: string; key: keyof typeof ch | "when"; before: string | null; after: string | null }[] = [
      { label: "Title", key: "summary", before: b?.summary ?? null, after: ch.summary ?? b?.summary ?? null },
      {
        label: "When",
        key: "when",
        before: b ? when(b, fmt) : null,
        after: when({ start: ch.start ?? b?.start, end: ch.end ?? b?.end, allDay: ch.allDay ?? b?.allDay }, fmt),
      },
      { label: "Where", key: "location", before: b?.location ?? null, after: ch.location ?? b?.location ?? null },
      { label: "Video call", key: "addConference", before: b?.conferenceUrl ? "Yes" : null, after: yesNo(ch.addConference) ?? (b?.conferenceUrl ? "Yes" : null) },
      { label: "Repeats", key: "recurrence", before: b?.recurring ? "Yes" : null, after: repeats(ch.recurrence) ?? (b?.recurring ? "Yes" : null) },
    ];
    const timeChanged = ch.start !== undefined || ch.end !== undefined || ch.allDay !== undefined;
    for (const f of fields) {
      const changed = a.kind === "calendar.create" || (f.key === "when" ? timeChanged : ch[f.key] !== undefined);
      // Fields the event doesn't have and the change doesn't set aren't worth a line.
      if (f.after === null && (a.kind === "calendar.create" || f.before === null)) continue;
      rows.push({ label: f.label, before: a.kind === "calendar.create" ? null : f.before, after: f.after, changed });
    }
    description = ch.description ?? null;
    guests = ch.attendees ?? guestsOf(b);
    if (a.kind === "calendar.create") {
      effects.push(`Creates ${named} on ${calendar}${rows.find((r) => r.label === "When")?.after ? `, ${rows.find((r) => r.label === "When")!.after}` : ""}.`);
    } else {
      const what = rows.filter((r) => r.changed).map((r) => CHANGE_WORD[r.label] ?? r.label.toLowerCase());
      if (ch.description !== undefined) what.push("the description");
      if (ch.attendees !== undefined) what.push("the guests");
      effects.push(`Changes ${what.length ? list(what) : "nothing visible"} of ${named} on ${calendar}.`);
    }
    if (ch.addConference) effects.push("Adds a Google Meet link.");
    const added = ch.attendees ? ch.attendees.filter((x) => !guestsOf(b).includes(x)) : [];
    const removed = ch.attendees && b ? guestsOf(b).filter((x) => !ch.attendees!.includes(x)) : [];
    if (added.length) effects.push(`Invites ${list(added)}.`);
    if (removed.length) effects.push(`Removes ${list(removed)} from the guest list.`);
    if (added.length && !c.notifyAttendees) effects.push("New guests see the event on their calendars even without an email.");
  }

  const self = a.accountEmail.toLowerCase();
  guests = guests.filter((g) => g.toLowerCase() !== self);
  effects.push(
    c.notified.length
      ? `Google emails ${people(c.notified.length)} about it.`
      : c.notifyAttendees
        ? "Nobody is emailed."
        : "Nobody is emailed: the agent turned notifications off.",
  );
  return {
    calendar,
    title,
    effects,
    rows,
    description,
    guests,
    moreGuests: !(a.kind === "calendar.create" || ch.attendees) && b ? Math.max(0, b.attendeeCount - b.attendees.length) : 0,
    emailed: c.notified,
    comment: a.kind === "calendar.rsvp" && a.body ? a.body : null,
  };
}

/** Every string of a calendar approval a human reads, for the hidden-characters check. */
export function calendarApprovalTexts(a: CalendarApproval): (string | null | undefined)[] {
  const c = a.calendar;
  const b = c.before;
  return [
    a.subject,
    a.body,
    a.reason,
    c.calendarName,
    c.change.summary,
    c.change.description,
    c.change.location,
    ...(c.change.attendees ?? []),
    ...(c.change.recurrence ?? []),
    ...c.notified,
    b?.summary,
    b?.location,
    b?.organizer?.name,
    ...(b?.attendees ?? []).flatMap((x) => [x.email, x.name]),
  ];
}
