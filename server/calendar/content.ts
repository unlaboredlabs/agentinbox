// Event descriptions as untrusted content (workstream C, docs/calendar.md "Content"). Descriptions are
// HTML-ish third-party text (an invite is an injection vector): they go through the same cleaning as mail
// bodies (server/mail/content.ts: htmlToMarkdown / cleanPlainText, suspiciousPhrases, truncateText) and are
// wrapped like mail bodies when shown to agents.

import type { MessageContent } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import type { CalendarEventRaw } from "../google/calendar.ts";
import type { Lane } from "../mail/pool.ts";
import { notImplemented } from "./todo.ts";

/**
 * The cleaned description as MessageContent (body markdown, attachments [] (or Drive attachment names),
 * signals.external = organizer outside the account's domain, signals.auth null). null without a description.
 */
export function eventDescriptionContent(_event: CalendarEventRaw, _opts: { accountEmail: string; maxChars: number }): MessageContent | null {
  throw notImplemented("eventDescriptionContent", "C");
}

/** eventDescriptionContent with HTML conversion in the content worker pool (stub; C implements it). */
export async function cleanEventDescription(
  _ctx: AppContext,
  _event: CalendarEventRaw,
  _opts: { accountEmail: string; maxChars: number },
  _lane: Lane = "interactive",
): Promise<MessageContent | null> {
  throw notImplemented("cleanEventDescription", "C");
}

/** Fetches the event and returns eventDescriptionContent (webhook includeBody). */
export async function eventContent(_ctx: AppContext, _accountId: string, _calendarId: string, _eventId: string): Promise<MessageContent | null> {
  throw notImplemented("eventContent", "C");
}
