// WHOOP events (https://developer.whoop.com/docs/developing/webhooks): signed v2 webhooks when the install has a
// public https URL, and a 15-minute poll otherwise. Events carry ids only; agents fetch the data with the tools.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IntegrationEvent, NativeEvents, NativeSourceDeps } from "../../broker/types.ts";
import { type Page, type Recovery, type Sleep, type Workout, PATHS, apiGet } from "./api.ts";
import { whoopUserIdFrom } from "./oauth.ts";

export const WHOOP_EVENT_TYPES = [
  "whoop.recovery_updated",
  "whoop.recovery_deleted",
  "whoop.sleep_updated",
  "whoop.sleep_deleted",
  "whoop.workout_updated",
  "whoop.workout_deleted",
];

export const SIGNATURE_HEADER = "x-whoop-signature";
export const TIMESTAMP_HEADER = "x-whoop-signature-timestamp";
/**
 * WHOOP documents no window, and retries a failed delivery five times over about an hour (possibly with the original
 * timestamp), so 2 hours either way of our clock. Replays inside it are absorbed by the trace_id dedupe (the route's
 * memory, then the outbox's dedupeKey); outside it they're refused (401).
 */
export const SIGNATURE_TOLERANCE_MS = 2 * 3_600_000;
export const POLL_INTERVAL_MS = 15 * 60_000;
/** How far back a poll looks for changed records (a sleep scored this morning started last night). */
const POLL_LOOKBACK_MS = 48 * 3_600_000;
const POLL_MAX_PAGES = 4;

const header = (headers: Record<string, string>, name: string): string | undefined => {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
};

/** base64(HMAC-SHA256(timestamp + rawBody, clientSecret)), compared in constant time, timestamp within tolerance. */
export function verifyWhoopSignature(headers: Record<string, string>, rawBody: Buffer, clientSecret: string, now: number): boolean {
  const signature = header(headers, SIGNATURE_HEADER);
  const timestamp = header(headers, TIMESTAMP_HEADER);
  if (!signature || !timestamp || !/^\d{1,16}$/.test(timestamp) || !clientSecret) return false;
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_TOLERANCE_MS) return false;
  const expected = createHmac("sha256", clientSecret).update(timestamp).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature.trim(), "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const WEBHOOK_TYPES: Record<string, { type: string; idKey: "sleepId" | "workoutId" }> = {
  // v2: a recovery event's id is the UUID of the sleep it belongs to.
  "recovery.updated": { type: "whoop.recovery_updated", idKey: "sleepId" },
  "recovery.deleted": { type: "whoop.recovery_deleted", idKey: "sleepId" },
  "sleep.updated": { type: "whoop.sleep_updated", idKey: "sleepId" },
  "sleep.deleted": { type: "whoop.sleep_deleted", idKey: "sleepId" },
  "workout.updated": { type: "whoop.workout_updated", idKey: "workoutId" },
  "workout.deleted": { type: "whoop.workout_deleted", idKey: "workoutId" },
};

/** What the webhook route passes in: the contract's deps plus the stored client record (CredentialStore.client). */
export type WhoopWebhookDeps = NativeSourceDeps & { clientSecret: string; client?: Record<string, unknown> | null };

export interface WhoopEventsOptions {
  now?: () => number;
}

type PollCursor = { v: 1; since: string };

function parseCursor(cursor: string | null): PollCursor | null {
  if (!cursor) return null;
  try {
    const c = JSON.parse(cursor) as Partial<PollCursor>;
    return c.v === 1 && typeof c.since === "string" && !Number.isNaN(Date.parse(c.since)) ? (c as PollCursor) : null;
  } catch {
    return null;
  }
}

export function createWhoopEvents(opts: WhoopEventsOptions = {}): NativeEvents {
  const now = opts.now ?? Date.now;

  return {
    types: WHOOP_EVENT_TYPES,
    pollIntervalMs: POLL_INTERVAL_MS,

    async handleWebhook(req, deps) {
      if (!verifyWhoopSignature(req.headers, req.rawBody, deps.clientSecret, now())) return null;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(req.rawBody.toString("utf8")) as Record<string, unknown>;
      } catch {
        deps.log.warn("whoop webhook: signed body isn't JSON", { connectionId: deps.connectionId });
        return [];
      }
      const mapped = typeof body?.type === "string" ? WEBHOOK_TYPES[body.type] : undefined;
      const traceId = typeof body?.trace_id === "string" ? body.trace_id.slice(0, 200) : "";
      const id = typeof body?.id === "string" || typeof body?.id === "number" ? String(body.id).slice(0, 100) : "";
      if (!mapped || !traceId || !id) {
        deps.log.info("whoop webhook ignored", { connectionId: deps.connectionId, type: typeof body?.type === "string" ? body.type.slice(0, 50) : null });
        return [];
      }
      // One app's webhook URL receives every member who authorized the app: only this connection's member counts.
      const expected = whoopUserIdFrom((deps as WhoopWebhookDeps).client);
      if (expected === null) {
        deps.log.warn("whoop webhook dropped: the connection has no stored WHOOP user id (reconnect it)", { connectionId: deps.connectionId });
        return [];
      }
      if (String(body.user_id) !== expected) {
        deps.log.warn("whoop webhook dropped: another WHOOP member of the same app", { connectionId: deps.connectionId });
        return [];
      }
      // Stateless: the route dedupes on dedupeKey, and only after the events are safely emitted.
      const data: Record<string, unknown> = { [mapped.idKey]: id, traceId };
      return [{ type: mapped.type, connectionId: deps.connectionId, dedupeKey: `whoop:${traceId}`, data }];
    },

    async poll(cursor, deps) {
      const prev = parseCursor(cursor);
      const t = now();
      const signal = AbortSignal.timeout(60_000);
      const start = new Date(t - POLL_LOOKBACK_MS).toISOString();
      const [recoveries, sleeps, workouts] = await Promise.all([
        pollAll<Recovery>(deps, PATHS.recoveries, start, signal),
        pollAll<Sleep>(deps, PATHS.sleeps, start, signal),
        pollAll<Workout>(deps, PATHS.workouts, start, signal),
      ]);
      const since = prev ? Date.parse(prev.since) : null;
      // High-water mark in WHOOP's clock (updated_at), not ours; our clock only when there's nothing at all.
      let high = since ?? Number.NEGATIVE_INFINITY;
      const events: IntegrationEvent[] = [];
      const add = (type: string, updatedAt: string, idKey: string, data: Record<string, unknown>) => {
        const u = Date.parse(updatedAt);
        if (Number.isNaN(u)) return;
        if (u > high) high = u;
        if (since === null || u <= since) return;
        events.push({ type, connectionId: deps.connectionId, dedupeKey: `whoop:poll:${type}:${idKey}:${updatedAt}`, data });
      };
      // Pending records come back as updated once scored; announcing them now would only be noise.
      for (const r of recoveries) if (r.score_state !== "PENDING_SCORE") add("whoop.recovery_updated", r.updated_at, r.sleep_id, { sleepId: r.sleep_id, cycleId: r.cycle_id });
      for (const s of sleeps) if (s.score_state !== "PENDING_SCORE") add("whoop.sleep_updated", s.updated_at, s.id, { sleepId: s.id, cycleId: s.cycle_id });
      for (const w of workouts) if (w.score_state !== "PENDING_SCORE") add("whoop.workout_updated", w.updated_at, w.id, { workoutId: w.id });
      // The first poll only sets the baseline: it doesn't replay the last two days.
      if (high === Number.NEGATIVE_INFINITY) high = t;
      return { events, cursor: JSON.stringify({ v: 1, since: new Date(high).toISOString() } satisfies PollCursor) };
    },
  };
}

async function pollAll<T>(deps: NativeSourceDeps, path: string, start: string, signal: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  let token: string | null = null;
  for (let i = 0; i < POLL_MAX_PAGES; i++) {
    const page: Page<T> | null = await apiGet<Page<T>>(deps, path, { start, limit: "25", nextToken: token ?? undefined }, signal);
    if (!page) break;
    out.push(...(page.records ?? []));
    token = page.next_token || null;
    if (!token) break;
  }
  return out;
}
