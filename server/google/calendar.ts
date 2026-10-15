// Google Calendar REST client contract (https://developers.google.com/workspace/calendar/api/v3/reference).
// Owned by workstream A (docs/calendar.md). Mirrors server/google/gmail.ts: one client per account, built
// on GoogleRuntime.request (token refresh, 401 retry, backoff, AccountNeedsReauthError), base URL
// ctx.config.google.calendarBase + "/calendar/v3".

import type { CalendarAccessRole, CalendarResponseStatus } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { hasReason } from "./http.ts";
import { GoogleApiError } from "./types.ts";

export const CALENDAR_API_SERVICE = "calendar-json.googleapis.com";

/** Console deep link that enables the Calendar API in `projectId` (Google picks the project when null). */
export const enableCalendarApiUrl = (projectId: string | null): string =>
  `https://console.cloud.google.com/flows/enableapi?apiid=${CALENDAR_API_SERVICE}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`;

export const enableCalendarApiCommand = (projectId: string): string => `gcloud services enable ${CALENDAR_API_SERVICE} --project=${projectId}`;

// ───────────── Raw Calendar REST shapes (subset) ─────────────

export interface CalendarListEntryRaw {
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  timeZone?: string;
  accessRole: CalendarAccessRole;
  primary?: boolean;
  backgroundColor?: string;
  selected?: boolean;
  hidden?: boolean;
  deleted?: boolean;
}

export interface CalendarDateTimeRaw {
  /** RFC 3339, for timed events. */
  dateTime?: string;
  /** YYYY-MM-DD, for all-day events. */
  date?: string;
  timeZone?: string;
}

export interface CalendarAttendeeRaw {
  email?: string;
  displayName?: string;
  responseStatus?: CalendarResponseStatus;
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  comment?: string;
}

export interface CalendarEventRaw {
  id: string;
  /** Incremental sync: deleted events come back with status "cancelled" and maybe only `id`. */
  status?: "confirmed" | "tentative" | "cancelled";
  etag?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarDateTimeRaw;
  end?: CalendarDateTimeRaw;
  endTimeUnspecified?: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: CalendarDateTimeRaw;
  iCalUID?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
  attendees?: CalendarAttendeeRaw[];
  attendeesOmitted?: boolean;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[]; createRequest?: unknown };
  eventType?: string;
  transparency?: "opaque" | "transparent";
  visibility?: string;
  guestsCanModify?: boolean;
}

export interface EventsListParams {
  /** Incremental sync: mutually exclusive with timeMin, timeMax, q, orderBy, iCalUID, updatedMin (400 otherwise). */
  syncToken?: string;
  pageToken?: string;
  timeMin?: string;
  timeMax?: string;
  q?: string;
  /** Expand recurring series into instances (needs timeMin/timeMax to stay bounded). */
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
  showDeleted?: boolean;
  maxResults?: number;
  iCalUID?: string;
}

export interface EventsListResult {
  items: CalendarEventRaw[];
  nextPageToken: string | null;
  /** Only on the last page. */
  nextSyncToken: string | null;
  timeZone: string | null;
}

/** Google's sendUpdates: who gets an email about a write. */
export type SendUpdates = "all" | "externalOnly" | "none";

export interface WriteOptions {
  sendUpdates: SendUpdates;
  /** Create a Meet link (conferenceDataVersion=1 with a createRequest). */
  conferenceDataVersion?: 0 | 1;
  /** Fail with 412 when the event changed since this etag (If-Match), e.g. for approved updates. */
  ifMatchEtag?: string;
}

export interface FreeBusyResult {
  calendars: Record<string, { busy: { start: string; end: string }[]; errors?: { domain: string; reason: string }[] }>;
}

export interface WatchChannel {
  id: string;
  resourceId: string;
  /** Epoch milliseconds as a string. */
  expiration: string;
}

/**
 * Thin Calendar REST client bound to one account. Throws GoogleApiError (see classifyCalendarError for the
 * disabled-API and missing-scope cases) or AccountNeedsReauthError, like GmailClient. Calendar calls don't
 * use the Gmail quota bucket (cost 0); Google's Calendar quotas are per minute per user and per project.
 * Writes are non-idempotent (`idempotent: false`) except patch/delete.
 */
export interface CalendarClient {
  readonly accountId: string;
  /** calendarList.list, every page, deleted/hidden entries skipped. */
  listCalendars(): Promise<CalendarListEntryRaw[]>;
  /** events.list. A stale syncToken throws GoogleApiError 410 (isSyncTokenExpired): full resync. */
  listEvents(calendarId: string, p: EventsListParams): Promise<EventsListResult>;
  /** events.get. 404 → GoogleApiError.notFound. */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEventRaw>;
  insertEvent(calendarId: string, event: Partial<CalendarEventRaw>, opts: WriteOptions): Promise<CalendarEventRaw>;
  /** events.patch: only the given fields change. */
  patchEvent(calendarId: string, eventId: string, patch: Partial<CalendarEventRaw>, opts: WriteOptions): Promise<CalendarEventRaw>;
  deleteEvent(calendarId: string, eventId: string, opts: WriteOptions): Promise<void>;
  /** freebusy.query. `items` are calendar ids or email addresses. */
  freeBusy(p: { timeMin: string; timeMax: string; items: string[]; timeZone?: string }): Promise<FreeBusyResult>;
  /** events.watch (push). `address` must be public https with a valid certificate. */
  watchEvents(calendarId: string, p: { id: string; address: string; token: string; ttlSeconds?: number }): Promise<WatchChannel>;
  /** channels.stop (same user + OAuth client that created it). 404 = already gone. */
  stopChannel(p: { id: string; resourceId: string }): Promise<void>;
}

/** Built by workstream A. Exposed as ctx.google.calendar(accountId) once wired (see GoogleService). */
export function createCalendarClient(_ctx: AppContext, _accountId: string): CalendarClient {
  throw new Error("Not implemented: Google Calendar client (workstream A, docs/calendar.md)");
}

// ───────────── Errors ─────────────

/**
 * What a Calendar API failure means for setup:
 * - api_disabled: 403 SERVICE_DISABLED / accessNotConfigured: the Calendar API is off in the Cloud project
 *   (ErrorInfo metadata.activationUrl, when present, is the enable link).
 * - scope_missing: 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT / insufficientPermissions: the account hasn't granted
 *   the calendar scopes (or unticked them).
 * - sync_token_expired: 410 (fullSyncRequired): discard the sync token and do a full resync.
 * - other: anything else (retry, report).
 */
export type CalendarErrorKind = "api_disabled" | "scope_missing" | "sync_token_expired" | "other";

export function classifyCalendarError(err: unknown): CalendarErrorKind {
  if (!(err instanceof GoogleApiError)) return "other";
  if (err.status === 410) return "sync_token_expired";
  if (err.status !== 403) return "other";
  if (hasReason(err, "SERVICE_DISABLED", "accessNotConfigured")) return "api_disabled";
  if (hasReason(err, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions")) return "scope_missing";
  // Older error bodies only say it in words.
  if (/has not been used in project|it is disabled/i.test(err.message)) return "api_disabled";
  if (/insufficient authentication scopes|insufficient permission/i.test(err.message)) return "scope_missing";
  return "other";
}

/** The enable link Google put in a SERVICE_DISABLED error, if any. */
export const activationUrl = (err: GoogleApiError): string | null => err.details.metadata?.activationUrl ?? null;
