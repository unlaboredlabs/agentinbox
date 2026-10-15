// Pure (relative imports only, no React): event visibility and the words of a calendar event row. Unit
// tests load it.

import { type CalendarEventChange, type CalendarEventSummary, type EventType, type Grant, isCalendarEventType, type MailEvent } from "../../../shared/types.ts";
import { fmtAddressShort, fmtEventWhen } from "../../lib/format.ts";
import { CALENDAR_CHANGE_LABEL, CALENDAR_RESPONSE_LABEL } from "../../lib/labels.ts";

/** Account-level events: any agent that can read the account's mail or calendar gets them, whatever its scopes. */
const ACCOUNT_EVENTS: EventType[] = ["account.auth_failed", "sync.gap"];

/**
 * Whether this grant lets its agent see the event; mirrors policy.canSeeEvent. Calendar events need
 * calendar.read and the event's calendar in the calendar scope; mail events need read (and the label scope);
 * account events need read or calendar.read.
 */
export function grantSees(g: Grant, e: MailEvent): boolean {
  if (g.accountId !== e.accountId) return false;
  if (ACCOUNT_EVENTS.includes(e.type)) return g.capabilities.includes("read") || g.capabilities.includes("calendar.read");
  if (isCalendarEventType(e.type)) {
    const calendarId = e.calendarEvent?.calendarId;
    return g.capabilities.includes("calendar.read") && !!calendarId && (g.calendarScope === null || g.calendarScope.includes(calendarId));
  }
  if (!g.capabilities.includes("read")) return false;
  if (g.labelScope === null) return true;
  // threadLabelIds comes with console events; the message's own labels are a (narrower) stand-in.
  const labels = e.threadLabelIds ?? e.message?.labelIds ?? [];
  return labels.some((id) => g.labelScope!.includes(id));
}

/** The URL when it is https, else null: links from events (organizer-supplied) are only ever clickable over https. */
export function httpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export interface CalendarEventLines {
  title: string;
  when: string;
  /** "organized by Dana", "you organize", or null when unknown. */
  organizer: string | null;
  /** Second line after the time: what changed, or the place. */
  note: string | null;
  /** Invitations still waiting for the account's answer. */
  needsAnswer: boolean;
}

const join = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** detail.changes of calendar.event_updated in words, e.g. "Changed: time and place"; null = unknown. */
export function changesInWords(detail: MailEvent["detail"]): string {
  const changes = detail?.changes;
  if (!Array.isArray(changes)) return "Changed (agentinbox hadn't seen the earlier version)";
  const words = (changes as CalendarEventChange[]).map((c) => CALENDAR_CHANGE_LABEL[c] ?? c);
  return words.length ? `Changed: ${join(words)}` : "Changed";
}

/**
 * The account organizes the event: Google's organizerSelf, or an organizer that is the account itself or the
 * event's own calendar (on a secondary calendar Google names the calendar as organizer).
 */
export function organizedHere(c: Pick<CalendarEventSummary, "organizerSelf" | "organizer" | "calendarId">, accountEmail: string): boolean {
  const email = c.organizer?.email.toLowerCase();
  return c.organizerSelf || email === accountEmail.toLowerCase() || email === c.calendarId.toLowerCase();
}

/** The row text of a calendar.* event; null for other events. */
export function calendarEventLines(e: MailEvent, fmt: { timeZone?: string; locale?: string; now?: number } = {}): CalendarEventLines | null {
  const c = e.calendarEvent;
  if (!c || !isCalendarEventType(e.type)) return null;
  const organizer = organizedHere(c, e.accountEmail) ? "you organize" : c.organizer ? `organized by ${fmtAddressShort(c.organizer)}` : null;
  let note: string | null = c.location;
  if (e.type === "calendar.event_updated") note = changesInWords(e.detail);
  else if (e.type === "calendar.event_cancelled") note = e.detail?.wasOrganizer ? "Cancelled (the account organized it)" : "Cancelled";
  else if (e.type === "calendar.invitation_received" && c.selfResponse && c.selfResponse !== "needsAction") {
    note = `Answered: ${CALENDAR_RESPONSE_LABEL[c.selfResponse]}`;
  }
  return {
    title: c.summary || "(no title)",
    when: fmtEventWhen(c, fmt),
    organizer,
    note,
    needsAnswer: e.type === "calendar.invitation_received" && c.selfResponse === "needsAction",
  };
}
