// "Add Google Calendar" state and probes (workstream D, docs/calendar.md "OAuth, setup and the upgrade flow").
// Whether Calendar is part of the install lives in InternalState "calendar.setup"; per-account state in
// accounts.scopes (granted, backfilled on every token refresh) and accounts.calendar_* (what Google said).

import type { CalendarInfo, CalendarSetupState } from "../../shared/types.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { type AccountRow, accountCalendar, accountScopes, allRows, getRow, updateRow } from "../google/accounts.ts";
import {
  activationUrl,
  type CalendarListEntryRaw,
  classifyCalendarError,
  enableCalendarApiCommand,
  enableCalendarApiUrl,
} from "../google/calendar.ts";
import { googleRuntime } from "../google/runtime.ts";
import { CALENDAR_SCOPES, describeScopes, hasScopes, missingScopes } from "../google/scopes.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../google/types.ts";
import { cleanLine } from "../mail/content.ts";
import type { InternalState } from "../settings.ts";
import { errorMessage, HttpError, notFound } from "../util/errors.ts";
import type { CalendarService } from "./types.ts";

export type CalendarSetup = Pick<CalendarService, "setupState" | "updateSetup" | "check" | "calendars">;

type Ctx = Pick<AppContext, "settings">;

const setupRow = (ctx: Ctx): InternalState["calendar.setup"] => ctx.settings.getState("calendar.setup") ?? { enabled: true };

/** Whether Calendar is part of this install (InternalState "calendar.setup"; no row = fresh install = enabled). */
export function calendarEnabled(ctx: Ctx): boolean {
  return setupRow(ctx).enabled;
}

/** A probe waits this long for Google; past it the state stays as it was (the connect still succeeds). */
const PROBE_TIMEOUT_MS = 15_000;

/** Google Auth Platform → Data Access, where the consent screen's scopes are listed. */
const dataAccessUrl = (projectId: string) => `https://console.cloud.google.com/auth/scopes?project=${encodeURIComponent(projectId)}`;

const projectId = (ctx: Pick<AppContext, "settings">) => ctx.settings.getState("google.client")?.projectId || null;

/**
 * The Calendar API in the project, as last observed. An account's recorded SERVICE_DISABLED wins; a sync
 * that succeeded after the last probe means it is on again.
 */
function apiState(s: InternalState["calendar.setup"], rows: AccountRow[]): CalendarSetupState["api"] {
  if (rows.some((r) => r.calendar_status === "api_disabled")) return "disabled";
  if (rows.some((r) => r.calendar_synced_at && (!s.api || r.calendar_synced_at > s.api.at))) return "enabled";
  return s.api?.state ?? "unknown";
}

/** The link that turns the Calendar API on: Google's own activationUrl when it sent one (it names the right project). */
export function enableApiLink(ctx: Pick<AppContext, "settings">): string | null {
  const s = setupRow(ctx);
  const project = projectId(ctx);
  return (s.api?.state === "disabled" && s.api.activationUrl) || (project ? enableCalendarApiUrl(project) : null);
}

export function setupState(ctx: Pick<AppContext, "settings" | "db">): CalendarSetupState {
  const s = setupRow(ctx);
  const project = projectId(ctx);
  const rows = allRows(ctx);
  const api = apiState(s, rows);
  const sync = new Map(
    ctx.db
      .all<{ account_id: string; n: number; push: number }>(
        `SELECT account_id, COUNT(*) AS n, SUM(channel_verified_at IS NOT NULL AND channel_expires_at > ?) AS push
         FROM calendar_sync GROUP BY account_id`,
        now(),
      )
      .map((r) => [r.account_id, r]),
  );
  const accounts = rows.map((r) => ({
    accountId: r.id,
    email: r.email,
    status: accountCalendar(r)?.status ?? "not_granted",
    missingScopes: missingScopes(accountScopes(r), CALENDAR_SCOPES),
    syncedCalendars: sync.get(r.id)?.n ?? 0,
    push: (sync.get(r.id)?.push ?? 0) > 0,
  }));
  return {
    enabled: s.enabled,
    dismissed: !!s.dismissedAt,
    scopes: [...CALENDAR_SCOPES],
    api,
    enableApiUrl: enableApiLink(ctx),
    enableApiCommand: project ? enableCalendarApiCommand(project) : null,
    dataAccessUrl: project ? dataAccessUrl(project) : null,
    accounts,
    step: !s.enabled ? "off" : api === "disabled" ? "enable_api" : accounts.some((a) => a.missingScopes.length) ? "connect_accounts" : "done",
  };
}

function recordApi(ctx: AppContext, state: "enabled" | "disabled", activation: string | null = null): void {
  const s = setupRow(ctx);
  if (state === "enabled" && s.api?.state === "enabled") return;
  ctx.settings.setState("calendar.setup", { ...s, api: { state, at: now(), activationUrl: activation } });
}

/** Writes accounts.calendar_* and broadcasts the account when that changed what the console shows. */
function setStatus(ctx: AppContext, row: AccountRow, status: AccountRow["calendar_status"], error: string | null): void {
  const fresh = getRow(ctx, row.id);
  if (!fresh || (fresh.calendar_status === status && fresh.calendar_error === error)) return;
  updateRow(ctx, row.id, { calendar_status: status, calendar_error: error }, true);
}

const API_DISABLED = "The Google Calendar API is turned off in your Google Cloud project.";

const needsReauth = (row: AccountRow) =>
  new HttpError(409, "needs_reauth", `${row.email} needs to be reconnected before agentinbox can read its calendars.`, `Accounts → ${row.email} → Reconnect.`);

const notGranted = (row: AccountRow, missing: string[]) =>
  new HttpError(
    409,
    "calendar_not_granted",
    missing.length === CALENDAR_SCOPES.length
      ? `Google Calendar isn't added to ${row.email} yet.`
      : `${row.email} granted only part of Google Calendar access (missing: ${describeScopes(missing)}).`,
    `Accounts → ${row.email} → Add Calendar, and keep every Calendar permission ticked on Google's screen.`,
  );

const apiDisabled = (ctx: AppContext) => {
  const link = enableApiLink(ctx);
  const project = projectId(ctx);
  return new HttpError(
    409,
    "calendar_api_disabled",
    API_DISABLED,
    (project ? `Run ${enableCalendarApiCommand(project)}, or open` : "Open") +
      ` ${link ?? "Google Cloud → APIs & Services → Library → Google Calendar API"} and click Enable. Wait a minute, then try again.`,
  );
};

/** Re-reads the granted scopes from Google (a forced token refresh backfills accounts.scopes). Never throws. */
async function backfillScopes(ctx: AppContext, row: AccountRow): Promise<AccountRow> {
  try {
    await googleRuntime(ctx).tokens.accessToken(row.id, { force: true });
  } catch (err) {
    if (!(err instanceof AccountNeedsReauthError)) ctx.log.child("calendar").warn("Token refresh failed", { email: row.email, error: errorMessage(err) });
  }
  return getRow(ctx, row.id) ?? row;
}

/**
 * calendarList.list as the account, recording what Google said: success clears API problems (on every
 * account: the API is per project), SERVICE_DISABLED marks the API off, a missing scope re-reads the
 * granted scopes (and retries once if they still look complete: the cached access token may predate a
 * consent). Throws the 409s of CalendarService.calendars.
 */
async function listCalendars(ctx: AppContext, row: AccountRow, retried = false): Promise<CalendarListEntryRaw[]> {
  try {
    const list = await ctx.google.calendar(row.id).listCalendars();
    recordApi(ctx, "enabled");
    setStatus(ctx, row, null, null);
    for (const other of allRows(ctx)) if (other.calendar_status === "api_disabled") setStatus(ctx, other, null, null);
    return list;
  } catch (err) {
    if (err instanceof AccountNeedsReauthError) throw needsReauth(row);
    const kind = classifyCalendarError(err);
    if (kind === "api_disabled") {
      recordApi(ctx, "disabled", activationUrl(err as GoogleApiError));
      setStatus(ctx, row, "api_disabled", API_DISABLED);
      throw apiDisabled(ctx);
    }
    if (kind === "scope_missing") {
      const fresh = await backfillScopes(ctx, row);
      const missing = missingScopes(accountScopes(fresh), CALENDAR_SCOPES);
      if (missing.length) throw notGranted(fresh, missing);
      if (!retried) return listCalendars(ctx, fresh, true);
    }
    throw err;
  }
}

/**
 * Asks Google for the account's calendar list right after a connect (or on a check) to learn whether the
 * Calendar API is on. Only accounts with every calendar scope are probed. Never throws.
 */
export async function probeCalendar(ctx: AppContext, accountId: string): Promise<void> {
  const row = getRow(ctx, accountId);
  if (!row || row.status === "needs_reauth" || !hasScopes(accountScopes(row), CALENDAR_SCOPES)) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      listCalendars(ctx, row),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Google didn't answer within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS);
      }),
    ]);
    ctx.calendar.kick(accountId);
  } catch (err) {
    // The 409s are recorded on the account already; anything else is left for sync to report.
    if (!(err instanceof HttpError)) ctx.log.child("calendar").warn("Calendar probe failed", { email: row.email, error: errorMessage(err) });
  } finally {
    clearTimeout(timer);
  }
}

const toInfo = (e: CalendarListEntryRaw, synced: Set<string>): CalendarInfo => ({
  id: e.id,
  name: cleanLine(e.summaryOverride || e.summary || e.id, 100),
  primary: !!e.primary,
  accessRole: e.accessRole,
  timeZone: e.timeZone ?? null,
  color: e.backgroundColor ?? null,
  synced: synced.has(e.id),
});

export function createCalendarSetup(ctx: AppContext): CalendarSetup {
  return {
    setupState: () => setupState(ctx),

    updateSetup(input) {
      const next = { ...setupRow(ctx) };
      if (input.enabled !== undefined) next.enabled = input.enabled;
      if (input.dismissed !== undefined) next.dismissedAt = input.dismissed ? now() : null;
      ctx.settings.setState("calendar.setup", next);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "calendar.setup.update", outcome: "ok", detail: { ...input } });
      return setupState(ctx);
    },

    async check() {
      for (const row of allRows(ctx)) {
        if (row.status === "needs_reauth") continue;
        // Calendar may have been granted (or revoked) outside agentinbox since the last refresh.
        if (!hasScopes(accountScopes(row), CALENDAR_SCOPES)) await backfillScopes(ctx, row);
        await probeCalendar(ctx, row.id);
      }
      return setupState(ctx);
    },

    async calendars(accountId) {
      const row = getRow(ctx, accountId);
      if (!row) throw notFound("Account");
      if (row.status === "needs_reauth") throw needsReauth(row);
      const missing = missingScopes(accountScopes(row), CALENDAR_SCOPES);
      if (missing.length) throw notGranted(row, missing);
      const list = await listCalendars(ctx, row);
      const synced = new Set(ctx.db.all<{ calendar_id: string }>("SELECT calendar_id FROM calendar_sync WHERE account_id = ?", row.id).map((r) => r.calendar_id));
      return list.map((e) => toInfo(e, synced)).sort((a, b) => Number(b.primary) - Number(a.primary));
    },
  };
}
