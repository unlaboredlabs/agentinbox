// Calendar sync engine (workstream A, docs/calendar.md "Sync"). Polls events.list with syncToken per synced
// calendar, turns changes into calendar.* events via ctx.events.emit, keeps calendar_sync and
// calendar_event_state up to date and records account calendar status (accounts.calendar_*).
//
// An account syncs only while it has every CALENDAR_SCOPES scope, isn't paused or needs_reauth, and some
// enabled agent's grant on it has calendar.read: a mail-only install makes no Calendar API calls at all.

import type { CalendarEventSummary, CalendarEventType, Settings } from "../../shared/types.ts";
import type { BusEvents } from "../bus.ts";
import type { AppContext } from "../context.ts";
import { json, now } from "../db/index.ts";
import { type AccountRow, accountScopes, getRow, updateRow } from "../google/accounts.ts";
import { type CalendarClient, type CalendarEventRaw, classifyCalendarError } from "../google/calendar.ts";
import { sleep } from "../google/http.ts";
import { googleRuntime } from "../google/runtime.ts";
import { CALENDAR_SCOPES, hasScopes } from "../google/scopes.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../google/types.ts";
import { cleanLine } from "../mail/content.ts";
import { errorMessage } from "../util/errors.ts";
import {
  type CalendarSyncRow,
  changesBetween,
  deleteEventState,
  deleteSyncCalendar,
  type EventState,
  eventStates,
  getEventState,
  putEventState,
  replaceEventStates,
  syncRows,
  tracked,
  updateSyncRow,
  upsertSyncCalendar,
} from "./state.ts";
import { isInvitation, summarizeEvent } from "./summary.ts";
import type { CalendarService } from "./types.ts";

export type CalendarSync = Pick<CalendarService, "kick" | "syncAccount" | "start" | "stop">;

export interface CalendarSyncOptions {
  /** The account's set of synced calendars changed (rows added or removed): push channels follow it (D). */
  onSyncSetChanged?(accountId: string): void;
}

/** The calendar list (which calendars sync) is re-read this often, and on kick. */
export const LIST_REFRESH_MS = 15 * 60_000;
/** Calendars with a verified push channel are still polled this often, in case a notification was lost. */
export const PUSH_SAFETY_NET_MS = 15 * 60_000;
/** Events created this long before the baseline still count as new (a sync racing the creation, clock skew). */
const NEW_GRACE_MS = 5 * 60_000;
const PAGE_SIZE = 1000;

/** Accounts some enabled agent reads calendars on (calendar.read), with the union of those grants' calendar scopes (null = every calendar). */
function readers(ctx: Pick<AppContext, "db">): Map<string, Set<string> | null> {
  const rows = ctx.db.all<{ account_id: string; calendar_scope: string | null }>(
    `SELECT g.account_id, g.calendar_scope FROM grants g JOIN agents a ON a.id = g.agent_id
     WHERE a.disabled = 0 AND EXISTS (SELECT 1 FROM json_each(g.capabilities) WHERE value = 'calendar.read')`,
  );
  const out = new Map<string, Set<string> | null>();
  for (const r of rows) {
    const scope = r.calendar_scope === null ? null : json.parse<string[]>(r.calendar_scope, []);
    const prev = out.get(r.account_id);
    if (prev === null || scope === null) out.set(r.account_id, null);
    else out.set(r.account_id, new Set([...(prev ?? []), ...scope]));
  }
  return out;
}

/** Calendar scopes granted and the account not paused or waiting for a reconnect. */
const syncable = (r: AccountRow) => (r.status === "active" || r.status === "error") && hasScopes(accountScopes(r), CALENDAR_SCOPES);

/** A pass over one account; requests made before it starts merge into it. */
interface Pass {
  /** null = every synced calendar. */
  calendars: Set<string> | null;
  /** Re-read the calendar list first. */
  refresh: boolean;
  /** Sync push-covered calendars too (kicks, "Sync now"). */
  force: boolean;
}

export function createCalendarSync(ctx: AppContext, opts: CalendarSyncOptions = {}): CalendarSync {
  return new Sync(ctx, opts);
}

class Sync implements CalendarSync {
  private readonly log;
  /** Started (polling, kicks honored). syncAccount works either way. */
  private running = false;
  /** stop() was called: passes in progress end after the current request. */
  private stopping = false;
  private loop: { ctrl: AbortController; done: Promise<void>; interval: number } | null = null;
  /** Tail of the per-account work queue: passes never overlap for one account. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, { pass: Pass; done: Promise<void> }>();
  /** accountId → when its calendar list was last read. */
  private readonly listedAt = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: CalendarSyncOptions,
  ) {
    this.log = ctx.log.child("calendar");
  }

  private readonly onSettings = (s: Settings) => {
    if (this.running && this.loop?.interval !== s.calendarPollSeconds) this.restart();
  };

  /** Grants changed: start (or stop) syncing the accounts they read. */
  private readonly onAgent = (e: BusEvents["agent"][0]) => {
    if (e.reason !== "key_rotated") this.kick();
  };

  start(): void {
    this.running = true;
    this.stopping = false;
    this.ctx.bus.on("settings", this.onSettings);
    this.ctx.bus.on("agent", this.onAgent);
    this.restart();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.ctx.bus.off("settings", this.onSettings);
    this.ctx.bus.off("agent", this.onAgent);
    const loop = this.loop;
    this.loop = null;
    loop?.ctrl.abort();
    await loop?.done;
    await Promise.race([Promise.allSettled([...this.chains.values()]), sleep(5000)]);
  }

  kick(accountId?: string, calendarId?: string): void {
    if (!this.running) return;
    const ids = accountId ? [accountId] : [...new Set([...readers(this.ctx).keys(), ...this.syncedAccounts()])];
    for (const id of ids) {
      this.schedule(id, { calendars: calendarId ? new Set([calendarId]) : null, refresh: !calendarId, force: true }).catch((err: unknown) =>
        this.log.debug("Calendar sync failed", { accountId: id, error: errorMessage(err) }),
      );
    }
  }

  syncAccount(accountId: string): Promise<void> {
    return this.schedule(accountId, { calendars: null, refresh: true, force: true });
  }

  // ───────────── Scheduling ─────────────

  private syncedAccounts(): string[] {
    return this.ctx.db.all<{ account_id: string }>("SELECT DISTINCT account_id FROM calendar_sync").map((r) => r.account_id);
  }

  private enqueue(accountId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(accountId) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    this.chains.set(accountId, tail);
    void tail.then(() => {
      if (this.chains.get(accountId) === tail) this.chains.delete(accountId);
    });
    return p;
  }

  /** Coalesces with a queued, not yet started pass for the account (one more runs after a pass in progress). */
  private schedule(accountId: string, want: Pass): Promise<void> {
    const queued = this.pending.get(accountId);
    if (queued) {
      const p = queued.pass;
      p.calendars = p.calendars === null || want.calendars === null ? null : new Set([...p.calendars, ...want.calendars]);
      p.refresh ||= want.refresh;
      p.force ||= want.force;
      return queued.done;
    }
    const pass: Pass = { ...want, calendars: want.calendars && new Set(want.calendars) };
    const done = this.enqueue(accountId, () => {
      this.pending.delete(accountId);
      return this.pass(accountId, pass);
    });
    this.pending.set(accountId, { pass, done });
    return done;
  }

  private restart(): void {
    const prev = this.loop;
    prev?.ctrl.abort();
    const interval = this.ctx.settings.get().calendarPollSeconds;
    const ctrl = new AbortController();
    const done = (prev?.done ?? Promise.resolve()).then(() => this.run(ctrl.signal, interval));
    this.loop = { ctrl, done, interval };
  }

  private async run(signal: AbortSignal, intervalSeconds: number): Promise<void> {
    while (!signal.aborted) {
      const all = readers(this.ctx);
      // Accounts nobody reads any more are forgotten; the rest poll (push-covered calendars less often).
      const ids = [...new Set([...all.keys(), ...this.syncedAccounts()])];
      const work = Promise.allSettled(ids.map((id) => this.schedule(id, { calendars: null, refresh: false, force: false })));
      await untilAborted(work, signal);
      await sleep(intervalSeconds * 1000, signal);
    }
  }

  // ───────────── One account ─────────────

  private async pass(accountId: string, p: Pass): Promise<void> {
    const row = getRow(this.ctx, accountId);
    if (!row) return;
    const scope = readers(this.ctx).get(accountId);
    if (scope === undefined) return this.forget(accountId);
    if (!syncable(row)) return;
    const client = this.ctx.google.calendar(accountId);
    try {
      const listed = this.listedAt.get(accountId);
      if (p.refresh || listed === undefined || Date.now() - listed > LIST_REFRESH_MS) await this.refreshList(row, client, scope);
      const failures: unknown[] = [];
      for (const cal of syncRows(this.ctx.db, accountId)) {
        if (this.stopping) return;
        if (p.calendars && !p.calendars.has(cal.calendar_id)) continue;
        if (!p.force && pushCovered(cal)) continue;
        try {
          await this.syncCalendar(row, client, cal);
        } catch (err) {
          // Account-wide problems end the pass; others are recorded per calendar and the rest still sync.
          if (err instanceof AccountNeedsReauthError || classifyCalendarError(err) === "api_disabled" || classifyCalendarError(err) === "scope_missing") throw err;
          updateSyncRow(this.ctx.db, accountId, cal.calendar_id, { last_error: errorMessage(err) });
          failures.push(err);
        }
      }
      if (failures.length) throw failures[0];
      this.recordSuccess(accountId);
    } catch (err) {
      await this.recordFailure(row, err);
      throw err;
    }
  }

  /** Synced calendars: owner/writer entries of the calendar list that some reading grant's scope covers. */
  private async refreshList(row: AccountRow, client: CalendarClient, scope: Set<string> | null): Promise<void> {
    const entries = await client.listCalendars();
    const wanted = entries.filter((e) => (e.accessRole === "owner" || e.accessRole === "writer") && (scope === null || scope.has(e.id)));
    let changed = false;
    for (const e of wanted) {
      const name = cleanLine(e.summaryOverride || e.summary || e.id, 200);
      if (upsertSyncCalendar(this.ctx.db, row.id, { id: e.id, name, accessRole: e.accessRole, primary: !!e.primary })) changed = true;
    }
    const keep = new Set(wanted.map((e) => e.id));
    for (const cal of syncRows(this.ctx.db, row.id)) {
      if (keep.has(cal.calendar_id)) continue;
      await this.removeCalendar(cal);
      changed = true;
    }
    this.listedAt.set(row.id, Date.now());
    if (changed) this.opts.onSyncSetChanged?.(row.id);
  }

  /** No grant reads the account any more: drop its calendars (a later grant starts from a fresh baseline). */
  private async forget(accountId: string): Promise<void> {
    const rows = syncRows(this.ctx.db, accountId);
    this.listedAt.delete(accountId);
    if (!rows.length) return;
    for (const cal of rows) await this.removeCalendar(cal);
    this.opts.onSyncSetChanged?.(accountId);
  }

  private async removeCalendar(cal: CalendarSyncRow): Promise<void> {
    if (cal.channel_id && cal.channel_resource_id) {
      await this.ctx.google
        .calendar(cal.account_id)
        .stopChannel({ id: cal.channel_id, resourceId: cal.channel_resource_id })
        .catch((err: unknown) => this.log.debug("Could not stop a calendar push channel", { calendarId: cal.calendar_id, error: errorMessage(err) }));
    }
    deleteSyncCalendar(this.ctx.db, cal.account_id, cal.calendar_id);
  }

  // ───────────── One calendar ─────────────

  private async syncCalendar(row: AccountRow, client: CalendarClient, cal: CalendarSyncRow): Promise<void> {
    if (cal.sync_token && cal.baseline_at) {
      try {
        const { items, syncToken } = await listAll(client, cal.calendar_id, { syncToken: cal.sync_token });
        for (const raw of items) this.apply(row.id, cal, raw, getEventState(this.ctx.db, row.id, cal.calendar_id, raw.id));
        updateSyncRow(this.ctx.db, row.id, cal.calendar_id, { sync_token: syncToken, last_sync_at: now(), last_error: null });
        return;
      } catch (err) {
        if (classifyCalendarError(err) !== "sync_token_expired") throw err;
        this.log.info("Calendar sync token expired; running a full resync", { email: row.email, calendarId: cal.calendar_id });
      }
    }
    await this.fullSync(row.id, client, cal);
  }

  /**
   * Lists the whole calendar and makes it the new baseline. The first one reports nothing (like Gmail's
   * baseline historyId); after a 410 the listing is diffed against the stored state so changes since the
   * last sync are still reported (gone → cancelled, changed → updated, new → created or invitation).
   */
  private async fullSync(accountId: string, client: CalendarClient, cal: CalendarSyncRow): Promise<void> {
    const { items, syncToken } = await listAll(client, cal.calendar_id, {});
    if (cal.baseline_at) {
      const known = eventStates(this.ctx.db, accountId, cal.calendar_id);
      for (const raw of items) this.apply(accountId, cal, raw, known.get(raw.id) ?? null);
      const listed = new Set(items.map((e) => e.id));
      for (const [id, prev] of known) if (!listed.has(id)) this.apply(accountId, cal, { id, status: "cancelled" }, prev);
    }
    const at = Date.now();
    const keep = items.filter((e) => e.status !== "cancelled" && tracked(e, at)).map((raw) => ({ raw, summary: summarizeEvent(raw, cal.calendar_id) }));
    replaceEventStates(this.ctx.db, accountId, cal.calendar_id, keep);
    const stamp = now();
    updateSyncRow(this.ctx.db, accountId, cal.calendar_id, { sync_token: syncToken, baseline_at: stamp, last_sync_at: stamp, last_error: null });
  }

  /** One changed event: emit what it means (docs/calendar.md "Incremental polling"), then store what was seen. */
  private apply(accountId: string, cal: CalendarSyncRow, raw: CalendarEventRaw, prev: EventState | null): void {
    const calendarId = cal.calendar_id;
    const emit = (type: CalendarEventType, summary: CalendarEventSummary, detail?: Record<string, unknown>, version?: string | null) =>
      this.ctx.events.emit({
        type,
        accountId,
        message: null,
        calendarEvent: summary,
        detail,
        dedupeKey:
          type === "calendar.invitation_received"
            ? `${accountId}:${calendarId}:${raw.id}:invitation`
            : `${accountId}:${calendarId}:${raw.id}:${type}:${version ?? raw.updated ?? raw.etag ?? ""}`,
      });

    if (raw.status === "cancelled") {
      // Deleted or cancelled; Google may send only the id, so the stored version is what gets reported.
      if (!prev) return;
      emit("calendar.event_cancelled", { ...prev.summary, status: "cancelled" }, { wasOrganizer: prev.summary.organizerSelf }, raw.updated ?? raw.etag ?? prev.summary.updated);
      deleteEventState(this.ctx.db, accountId, calendarId, raw.id);
      return;
    }

    const summary = summarizeEvent(raw, calendarId);
    const keep = tracked(raw);
    if (!prev) {
      const created = Date.parse(raw.created ?? "");
      const isNew = created >= Date.parse(cal.baseline_at!) - NEW_GRACE_MS;
      // Invitations first: being added to a meeting created long ago is the usual case.
      if (isInvitation(raw) && (isNew || keep)) emit("calendar.invitation_received", summary);
      else if (isNew) emit("calendar.event_created", summary);
      else if (keep) emit("calendar.event_updated", summary, { changes: null });
    } else {
      const changes = changesBetween(prev, raw);
      if (changes.length) {
        if (prev.summary.selfResponse === null && isInvitation(raw)) emit("calendar.invitation_received", summary);
        else emit("calendar.event_updated", summary, { changes });
      }
    }
    if (keep) putEventState(this.ctx.db, accountId, calendarId, raw, summary);
    else if (prev) deleteEventState(this.ctx.db, accountId, calendarId, raw.id);
  }

  // ───────────── Account status ─────────────

  private setStatus(accountId: string, status: AccountRow["calendar_status"], error: string | null, extra: { calendar_synced_at?: string } = {}): void {
    const row = getRow(this.ctx, accountId);
    if (!row) return;
    const changed = row.calendar_status !== status || row.calendar_error !== error;
    updateRow(this.ctx, accountId, { calendar_status: status, calendar_error: error, ...extra }, changed);
    if (changed && error) this.log.warn("Calendar sync failed", { email: row.email, error });
    else if (changed && row.calendar_error) this.log.info("Calendar sync recovered", { email: row.email });
  }

  private recordSuccess(accountId: string): void {
    this.setStatus(accountId, null, null, { calendar_synced_at: now() });
    this.noteApi("enabled");
  }

  /** Records why the pass failed on the account (Account.calendar). Auth failures are the token manager's. */
  private async recordFailure(row: AccountRow, err: unknown): Promise<void> {
    if (err instanceof AccountNeedsReauthError) return;
    switch (classifyCalendarError(err)) {
      case "api_disabled":
        this.setStatus(row.id, "api_disabled", errorMessage(err));
        this.noteApi("disabled", errorMessage(err));
        return;
      case "scope_missing": {
        // A refresh re-reads the granted scopes (the token response's `scope`); the status then derives from them.
        await googleRuntime(this.ctx)
          .tokens.accessToken(row.id, { force: true })
          .catch(() => {});
        const fresh = getRow(this.ctx, row.id);
        if (fresh && hasScopes(accountScopes(fresh), CALENDAR_SCOPES)) {
          this.setStatus(row.id, "error", `Google says the Calendar permissions are missing: ${errorMessage(err)}`);
        } else this.setStatus(row.id, null, null);
        return;
      }
      default:
        this.setStatus(row.id, "error", `Calendar sync failed: ${errorMessage(err)}`);
    }
  }

  /** CalendarSetupState.api as last observed (written on change only). */
  private noteApi(state: "enabled" | "disabled", error: string | null = null): void {
    const setup = this.ctx.settings.getState("calendar.setup");
    if (setup?.api?.state === state) return;
    this.ctx.settings.setState("calendar.setup", { enabled: true, ...setup, api: { state, at: now(), error } });
  }
}

/** Resolves when `p` settles or the signal aborts, whichever comes first (p keeps running). */
function untilAborted(p: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    p.then(done, done);
  });
}

/** A verified, unexpired push channel that synced recently: polling can wait (PUSH_SAFETY_NET_MS). */
function pushCovered(cal: CalendarSyncRow): boolean {
  if (!cal.channel_verified_at || !cal.channel_expires_at || Date.parse(cal.channel_expires_at) <= Date.now()) return false;
  return !!cal.last_sync_at && Date.now() - Date.parse(cal.last_sync_at) < PUSH_SAFETY_NET_MS;
}

/** Every page of events.list (singleEvents=false, as the sync token requires). */
async function listAll(client: CalendarClient, calendarId: string, p: { syncToken?: string }): Promise<{ items: CalendarEventRaw[]; syncToken: string }> {
  const items: CalendarEventRaw[] = [];
  let pageToken: string | undefined;
  let syncToken: string | null = null;
  do {
    const r = await client.listEvents(calendarId, { ...p, pageToken, maxResults: PAGE_SIZE });
    items.push(...r.items);
    pageToken = r.nextPageToken ?? undefined;
    syncToken = r.nextSyncToken;
  } while (pageToken);
  if (!syncToken) throw new GoogleApiError(502, "Google Calendar returned no sync token", "invalid_response");
  return { items, syncToken };
}
