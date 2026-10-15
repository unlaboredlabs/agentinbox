// Calendar guardrails as pure functions over a Grant (workstream B; docs/calendar.md "Grants and policy").
// Callers (server/calendar/agent.ts, server/calendar/approvals.ts) throw these as PolicyDenied.

import type { Grant } from "../../shared/types.ts";
import { PolicyDenied } from "../util/errors.ts";
import { disallowedRecipients } from "./enforce.ts";

/** MCP calendar tools that may email people; their successful calls with detail.emailed count toward send caps. */
export const CALENDAR_WRITE_ACTIONS = ["create_calendar_event", "update_calendar_event", "delete_calendar_event", "respond_to_invitation"] as const;

/** Google's "primary" alias resolves to the account's own calendar id: its email. */
export const resolveCalendarId = (calendarId: string, accountEmail: string): string =>
  calendarId.trim().toLowerCase() === "primary" ? accountEmail.toLowerCase() : calendarId.trim();

/** Whether the grant's calendar scope covers this calendar id (null scope = every calendar). */
export function calendarInScope(grant: Pick<Grant, "calendarScope">, calendarId: string): boolean {
  return grant.calendarScope === null || grant.calendarScope.includes(calendarId);
}

/** Like notAccessible for mail: never reveals whether an out-of-scope calendar exists. */
export const calendarNotAccessible = (calendarId: string) =>
  `Calendar ${calendarId} was not found or is not accessible to you. Use list_calendars to see the calendars you can use.`;

export function assertCalendarInScope(grant: Grant, calendarId: string): void {
  if (!calendarInScope(grant, calendarId)) throw new PolicyDenied("calendar_scope", calendarNotAccessible(calendarId));
}

const isResource = (email: string) => /@resource\.calendar\.google\.com$/i.test(email);

/**
 * Who a write puts in touch with whom (docs/calendar.md "Attendees and allowTo"):
 * - `emailed`: addresses Google will email (sendUpdates "all"): every non-self, non-room attendee after the
 *   change plus removed ones (they get a cancellation), or everyone before a delete the account organizes.
 * - `checked`: addresses the grant's allowTo must cover: `emailed` when notifying; otherwise only newly
 *   added attendees (adding someone shares the event with them even without an email).
 * Emails are compared lower-cased.
 */
export function attendeeImpact(input: {
  kind: "create" | "update" | "delete";
  selfEmail: string;
  /** Attendees before the change (update/delete). */
  before: string[];
  /** Attendees after the change (create/update; for update omit = unchanged → pass `before`). */
  after: string[];
  notify: boolean;
  /** delete: whether the account organizes the event (only then do attendees get a cancellation). */
  organizerSelf?: boolean;
}): { emailed: string[]; checked: string[] } {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter((x) => x && x !== input.selfEmail.toLowerCase() && !isResource(x)))];
  const before = norm(input.before);
  const after = input.kind === "delete" ? [] : norm(input.after);
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  let emailed: string[] = [];
  if (input.notify) {
    if (input.kind === "delete") emailed = input.organizerSelf ? before : [];
    else emailed = [...after, ...removed];
  }
  return { emailed, checked: input.notify ? emailed : added };
}

/** Throws allow_to when the grant's recipient allowlist doesn't cover every `checked` attendee. */
export function assertAttendeesAllowed(grant: Grant, checked: string[]): void {
  const bad = disallowedRecipients(grant, checked);
  if (bad.length) {
    throw new PolicyDenied(
      "allow_to",
      `Not allowed to invite or notify ${bad.join(", ")}. This account only lets you contact: ${grant.allowTo.join(", ")}. ` +
        "Remove those attendees, set notify_attendees to false (attendees already on the event are then not emailed), or ask the operator to extend the allowlist.",
    );
  }
}
