// Demo Google Calendar data for the ops account: a few calendars and upcoming events (the sync baseline,
// which reports nothing), then the changes that show up as calendar.* events in the console: an
// invitation from a vendor, a new event, a reschedule and a cancellation.

import type { AppContext } from "../../server/context.ts";
import type { CalendarDateTimeRaw } from "../../server/google/calendar.ts";
import type { FakeGoogle } from "../../test/fake-google.ts";

const DAY = 86_400_000;

/** `days` from today at hh:mm UTC, lasting `minutes`. */
function slot(days: number, hour: number, minutes = 60): { start: CalendarDateTimeRaw; end: CalendarDateTimeRaw } {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  const start = d.getTime() + days * DAY;
  return { start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + minutes * 60_000).toISOString() } };
}

/** All-day, `days` from today for `length` days. */
function allDay(days: number, length = 1): { start: CalendarDateTimeRaw; end: CalendarDateTimeRaw } {
  const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
  return { start: { date: day(days) }, end: { date: day(days + length) } };
}

const people = (...emails: string[]) => emails.map((email) => ({ email }));

export async function seedCalendar(fake: FakeGoogle, ctx: AppContext, email: string, accountId: string): Promise<void> {
  const cal = fake.calendar;
  const rota = cal.addCalendar(email, { name: "Support rota" });
  const holidays = cal.addCalendar(email, { name: "Holidays in United States", accessRole: "reader", id: "en.usa#holiday@group.v.calendar.google.com" });
  cal.putEvent(email, holidays, { summary: "Veterans Day", ...allDay(12), transparency: "transparent" });

  cal.putEvent(email, email, {
    summary: "Weekly ops sync",
    ...slot(1, 15, 30),
    recurrence: ["RRULE:FREQ=WEEKLY"],
    attendees: people("jules@acme.dev", "priya@acme.dev"),
    hangoutLink: "https://meet.google.com/ops-wkly-syn",
  });
  const planning = cal.putEvent(email, email, {
    summary: "Q4 planning",
    location: "HQ, 3rd floor (Juniper)",
    ...slot(3, 14, 120),
    attendees: people("jules@acme.dev", "priya@acme.dev", "sam@acme.dev"),
  });
  const lunch = cal.putEvent(email, email, { summary: "Lunch & learn: Postgres 17", ...slot(2, 12) });
  cal.putEvent(email, rota, { summary: "On call: Jules", ...allDay(0, 7) });
  // Baseline: what is already on the calendar isn't news.
  await ctx.calendar.syncAccount(accountId);

  cal.invite("dana@northwind.io", [email], {
    summary: "INV-2291 walkthrough",
    organizer: { email: "dana@northwind.io", displayName: "Dana Whitfield" },
    description: "Let's go through the incident-response line on INV-2291 before you approve it.",
    ...slot(1, 17, 30),
    hangoutLink: "https://meet.google.com/nwd-inv-2291",
  });
  cal.putEvent(email, rota, { summary: "Postgres maintenance window", location: "us-east-1", ...slot(5, 2, 90) });
  cal.putEvent(email, email, { id: planning.id, ...slot(4, 15, 120) });
  cal.cancelEvent(email, email, lunch.id);
  await ctx.calendar.syncAccount(accountId);
}
