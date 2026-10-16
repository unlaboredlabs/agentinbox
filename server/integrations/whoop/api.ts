// WHOOP API v2 (https://developer.whoop.com/api/): endpoints, record shapes and the one request helper every
// tool, poll and check goes through. Errors map onto the broker's SourceError codes.

import { SourceError } from "../../broker/types.ts";

export const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";
export const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const WHOOP_DASHBOARD_URL = "https://developer-dashboard.whoop.com";
export const WHOOP_CREATE_APP_URL = "https://developer-dashboard.whoop.com/apps/create";

/** Data scopes (ticked on the app in the dashboard) plus `offline`, which WHOOP requires for a refresh token. */
export const WHOOP_DATA_SCOPES = ["read:recovery", "read:cycles", "read:workout", "read:sleep", "read:profile", "read:body_measurement"];
export const WHOOP_SCOPES = [...WHOOP_DATA_SCOPES, "offline"];

/** WHOOP's page size cap for collections. */
export const PAGE_MAX = 25;

export const PATHS = {
  profile: "/v2/user/profile/basic",
  body: "/v2/user/measurement/body",
  cycles: "/v2/cycle",
  cycle: (id: number | string) => `/v2/cycle/${encodeURIComponent(String(id))}`,
  cycleSleep: (id: number | string) => `/v2/cycle/${encodeURIComponent(String(id))}/sleep`,
  cycleRecovery: (id: number | string) => `/v2/cycle/${encodeURIComponent(String(id))}/recovery`,
  recoveries: "/v2/recovery",
  sleeps: "/v2/activity/sleep",
  sleep: (id: string) => `/v2/activity/sleep/${encodeURIComponent(id)}`,
  workouts: "/v2/activity/workout",
  workout: (id: string) => `/v2/activity/workout/${encodeURIComponent(id)}`,
} as const;

export type ScoreState = "SCORED" | "PENDING_SCORE" | "UNSCORABLE";

export interface Page<T> {
  records: T[];
  next_token?: string | null;
}

export interface Recovery {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: ScoreState;
  score?: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
}

export interface Sleep {
  id: string;
  cycle_id: number;
  v1_id?: number | null;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: ScoreState;
  score?: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_no_data_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      sleep_cycle_count: number;
      disturbance_count: number;
    };
    sleep_needed: {
      baseline_milli: number;
      need_from_sleep_debt_milli: number;
      need_from_recent_strain_milli: number;
      need_from_recent_nap_milli: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
}

export interface Cycle {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  /** Absent/null while the cycle is ongoing. */
  end?: string | null;
  timezone_offset: string;
  score_state: ScoreState;
  score?: { strain: number; kilojoule: number; average_heart_rate: number; max_heart_rate: number };
}

export interface Workout {
  id: string;
  v1_id?: number | null;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_name: string;
  sport_id?: number;
  score_state: ScoreState;
  score?: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    altitude_change_meter?: number;
    zone_durations?: {
      zone_zero_milli?: number;
      zone_one_milli?: number;
      zone_two_milli?: number;
      zone_three_milli?: number;
      zone_four_milli?: number;
      zone_five_milli?: number;
    };
  };
}

export interface Profile {
  user_id: number;
  email: string;
  first_name: string;
  last_name: string;
}

export interface BodyMeasurement {
  height_meter: number;
  weight_kilogram: number;
  max_heart_rate: number;
}

/** A 4xx WHOOP answered that isn't auth or rate limiting: a tool-level failure (isError), not a SourceError. */
export class WhoopRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WhoopRequestError";
  }
}

export interface ApiDeps {
  accessToken(signal: AbortSignal): Promise<string>;
  fetch: typeof fetch;
}

const DEFAULT_RETRY_MS = 60_000;

/** Backoff from a 429: Retry-After if present, else X-RateLimit-Reset (seconds, per WHOOP's rate-limiting doc). */
export function retryAfterMs(headers: Headers): number {
  for (const name of ["retry-after", "x-ratelimit-reset"]) {
    const v = headers.get(name);
    if (v && /^\d+(\.\d+)?$/.test(v.trim())) return Math.max(1000, Math.ceil(Number(v) * 1000));
  }
  return DEFAULT_RETRY_MS;
}

/**
 * GET a v2 path. Returns null on 404. A 401 re-asks for the access token once (another call may have rotated it,
 * which invalidates the old one at WHOOP) and retries if it changed; a 401 with the same token is `needs_reauth`.
 */
export async function apiGet<T>(deps: ApiDeps, path: string, query: Record<string, string | undefined>, signal: AbortSignal): Promise<T | null> {
  const url = new URL(WHOOP_API_BASE + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  let token = await deps.accessToken(signal);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new SourceError("unavailable", `WHOOP is unreachable: ${(err as Error).message}`);
    }
    if (res.status === 401) {
      await res.body?.cancel();
      if (attempt === 0) {
        const next = await deps.accessToken(signal);
        if (next !== token) {
          token = next;
          continue;
        }
      }
      throw new SourceError("needs_reauth", "WHOOP rejected the access token");
    }
    if (res.status === 429) {
      await res.body?.cancel();
      throw new SourceError("rate_limited", "WHOOP's rate limit was reached (100 requests a minute, 10,000 a day)", retryAfterMs(res.headers));
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      throw new SourceError("unavailable", `WHOOP answered ${res.status}`);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const hint = res.status === 403 ? " (the connection may be missing a scope: reconnect WHOOP and approve every scope)" : "";
      throw new WhoopRequestError(res.status, `WHOOP refused the request (${res.status})${hint}${text ? `: ${text}` : ""}`);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new SourceError("protocol", "WHOOP sent a response that isn't JSON");
    }
  }
}

/** Collects up to `limit` records across pages, starting at `nextToken`; returns where to continue. */
export async function collect<T>(
  deps: ApiDeps,
  path: string,
  range: { start?: string; end?: string },
  limit: number,
  nextToken: string | null,
  signal: AbortSignal,
): Promise<{ records: T[]; nextToken: string | null }> {
  const records: T[] = [];
  let token = nextToken;
  do {
    const size = Math.min(PAGE_MAX, limit - records.length);
    const page = await apiGet<Page<T>>(deps, path, { start: range.start, end: range.end, limit: String(size), nextToken: token ?? undefined }, signal);
    if (!page) return { records, nextToken: null };
    records.push(...(Array.isArray(page.records) ? page.records.slice(0, size) : []));
    token = page.next_token || null;
  } while (token && records.length < limit);
  return { records, nextToken: token };
}
