// A fake of the WHOOP API (OAuth + v2 endpoints) as an in-process `fetch`: no sockets, deterministic.
// - OAuth: authorization codes, 1 h access tokens, rotating single-use refresh tokens; reusing a spent refresh token
//   revokes the whole grant (access and refresh), like a stolen-token response.
// - v2 collections with start/end/limit/nextToken, sorted newest first; by-id and per-cycle endpoints.
// - Forced 429s with X-RateLimit-Reset; a signed webhook builder.

import { createHmac, randomBytes } from "node:crypto";
import type { BodyMeasurement, Cycle, Profile, Recovery, Sleep, Workout } from "../server/integrations/whoop/api.ts";

export const FAKE_WHOOP_CLIENT = { clientId: "fake-whoop-client-id", clientSecret: "fake-whoop-client-secret" };
export const FAKE_REDIRECT = "http://localhost:8425/oauth/connections/callback";

const API = "https://api.prod.whoop.com/developer";
const AUTH = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN = "https://api.prod.whoop.com/oauth/oauth2/token";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Grant {
  clientId: string;
  scope: string;
  revoked: boolean;
}

export interface FakeWhoopOptions {
  now?: () => number;
  /** Days of generated history ending at now(). */
  days?: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export class FakeWhoop {
  readonly now: () => number;
  clients = new Map<string, { secret: string; redirectUris: string[] }>([[FAKE_WHOOP_CLIENT.clientId, { secret: FAKE_WHOOP_CLIENT.clientSecret, redirectUris: [FAKE_REDIRECT] }]]);
  private codes = new Map<string, { clientId: string; redirectUri: string; scope: string; grant: Grant }>();
  private access = new Map<string, { grant: Grant; expiresAt: number }>();
  private refresh = new Map<string, { grant: Grant; used: boolean }>();
  /** Every request seen (method + path + query), for assertions. */
  requests: string[] = [];
  tokenRequests: Record<string, string>[] = [];
  private forced429 = 0;
  private reset429 = "7";

  profile: Profile = { user_id: 10129, email: "jaynay@example.com", first_name: "Jay", last_name: "Nay" };
  body: BodyMeasurement | null = { height_meter: 1.8288, weight_kilogram: 90.7185, max_heart_rate: 200 };
  cycles: Cycle[] = [];
  sleeps: Sleep[] = [];
  recoveries: Recovery[] = [];
  workouts: Workout[] = [];

  constructor(opts: FakeWhoopOptions = {}) {
    this.now = opts.now ?? (() => Date.parse("2026-10-16T12:00:00Z"));
    this.seed(opts.days ?? 10);
  }

  /** Deterministic history: one cycle, sleep and recovery per day (today's cycle ongoing), a workout every other day. */
  seed(days: number): void {
    const today = Math.floor(this.now() / DAY) * DAY;
    const uid = this.profile.user_id;
    const iso = (t: number) => new Date(t).toISOString();
    const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");
    const uuid = (kind: number, i: number) => `${hex(kind, 8)}-0000-4000-8000-${hex(i, 12)}`;
    this.cycles = [];
    this.sleeps = [];
    this.recoveries = [];
    this.workouts = [];
    for (let i = 0; i < days; i++) {
      const day = today - i * DAY;
      const wake = day + 6 * HOUR; // 06:00 UTC, 08:00 at +02:00
      const cycleId = 93_000 + (days - i);
      const sleepId = uuid(0x51ee9, days - i);
      const bedtime = wake - 8 * HOUR;
      const updated = iso(wake + 30 * 60_000);
      this.cycles.push({
        id: cycleId,
        user_id: uid,
        created_at: iso(wake),
        updated_at: updated,
        start: iso(wake),
        end: i === 0 ? null : iso(wake + DAY),
        timezone_offset: "+02:00",
        score_state: "SCORED",
        score: { strain: 8 + (i % 7), kilojoule: 8000 + i * 100, average_heart_rate: 68, max_heart_rate: 150 + i },
      });
      this.sleeps.push({
        id: sleepId,
        cycle_id: cycleId,
        v1_id: null,
        user_id: uid,
        created_at: iso(wake),
        updated_at: updated,
        start: iso(bedtime),
        end: iso(wake),
        timezone_offset: "+02:00",
        nap: false,
        score_state: "SCORED",
        score: {
          stage_summary: {
            total_in_bed_time_milli: 8 * HOUR,
            total_awake_time_milli: 30 * 60_000,
            total_no_data_time_milli: 0,
            total_light_sleep_time_milli: 4 * HOUR,
            total_slow_wave_sleep_time_milli: 90 * 60_000,
            total_rem_sleep_time_milli: 2 * HOUR,
            sleep_cycle_count: 4,
            disturbance_count: 3,
          },
          // Yesterday's sleep came after a nap: WHOOP reports the nap credit as a negative need.
          sleep_needed: { baseline_milli: 8 * HOUR, need_from_sleep_debt_milli: 20 * 60_000, need_from_recent_strain_milli: 10 * 60_000, need_from_recent_nap_milli: i === 1 ? -45 * 60_000 : 0 },
          respiratory_rate: 15.2,
          sleep_performance_percentage: 88,
          sleep_consistency_percentage: 79,
          sleep_efficiency_percentage: 93.75,
        },
      });
      this.recoveries.push({
        cycle_id: cycleId,
        sleep_id: sleepId,
        user_id: uid,
        created_at: iso(wake + 10 * 60_000),
        updated_at: updated,
        score_state: "SCORED",
        score: { user_calibrating: false, recovery_score: 60 + i, resting_heart_rate: 52, hrv_rmssd_milli: 65.27, spo2_percentage: 96.4, skin_temp_celsius: 33.71 },
      });
      if (i % 2 === 1) {
        this.workouts.push({
          id: uuid(0x30c0, days - i),
          v1_id: null,
          user_id: uid,
          created_at: iso(wake + 11 * HOUR),
          updated_at: iso(wake + 11 * HOUR),
          start: iso(wake + 10 * HOUR),
          end: iso(wake + 10 * HOUR + 52 * 60_000),
          timezone_offset: "+02:00",
          sport_name: "running",
          sport_id: 0,
          score_state: "SCORED",
          score: {
            strain: 12.3,
            average_heart_rate: 151,
            max_heart_rate: 178,
            kilojoule: 2100,
            percent_recorded: 100,
            distance_meter: 8204.2,
            altitude_gain_meter: 61,
            altitude_change_meter: 2,
            zone_durations: { zone_zero_milli: 60_000, zone_one_milli: 300_000, zone_two_milli: 1_200_000, zone_three_milli: 1_080_000, zone_four_milli: 420_000, zone_five_milli: 60_000 },
          },
        });
      }
    }
  }

  /** The next `n` requests (API or token) answer 429. */
  rateLimitNext(n: number, resetSeconds = "7"): void {
    this.forced429 = n;
    this.reset429 = resetSeconds;
  }

  /**
   * The user's browser at the authorize URL, approving: validates it like WHOOP and returns the redirect target
   * (`redirect_uri?code=…&state=…`).
   */
  approve(authorizeUrl: string): string {
    const u = new URL(authorizeUrl);
    if (u.origin + u.pathname !== AUTH) throw new Error(`not the WHOOP authorize URL: ${authorizeUrl}`);
    const q = u.searchParams;
    const client = this.clients.get(q.get("client_id") ?? "");
    if (!client) throw new Error("unknown client_id");
    const redirectUri = q.get("redirect_uri") ?? "";
    if (!client.redirectUris.includes(redirectUri)) throw new Error("redirect_uri not registered");
    if (q.get("response_type") !== "code") throw new Error("response_type must be code");
    if ((q.get("state") ?? "").length < 8) throw new Error("state must be at least 8 characters");
    const code = `code-${randomBytes(6).toString("hex")}`;
    this.codes.set(code, { clientId: q.get("client_id")!, redirectUri, scope: q.get("scope") ?? "", grant: { clientId: q.get("client_id")!, scope: q.get("scope") ?? "", revoked: false } });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state")!);
    return back.toString();
  }

  /** Expires every access token now (the next API call gets 401). */
  expireAccessTokens(): void {
    for (const t of this.access.values()) t.expiresAt = 0;
  }

  /** A signed v2 webhook as WHOOP sends it. */
  webhook(event: { type: string; id: string | number; trace_id: string; user_id?: number }, opts: { secret?: string; timestamp?: number } = {}) {
    const rawBody = Buffer.from(JSON.stringify({ user_id: event.user_id ?? this.profile.user_id, id: event.id, type: event.type, trace_id: event.trace_id }));
    const timestamp = String(opts.timestamp ?? this.now());
    const signature = createHmac("sha256", opts.secret ?? FAKE_WHOOP_CLIENT.clientSecret).update(timestamp + rawBody.toString("utf8")).digest("base64");
    return { headers: { "x-whoop-signature": signature, "x-whoop-signature-timestamp": timestamp, "content-type": "application/json" }, rawBody };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    if (this.forced429 > 0) {
      this.forced429--;
      return json(429, { message: "Too Many Requests" }, { "x-ratelimit-limit": "100, 100;window=60, 10000;window=86400", "x-ratelimit-remaining": "0", "x-ratelimit-reset": this.reset429 });
    }
    if (url.toString().split("?")[0] === TOKEN && method === "POST") return this.token(new URLSearchParams(String(init?.body ?? "")));
    if (url.origin + "/developer" === API && method === "GET") return this.api(url, new Headers(init?.headers).get("authorization"));
    return json(404, { message: "not found" });
  };

  private token(p: URLSearchParams): Response {
    this.tokenRequests.push(Object.fromEntries(p));
    const client = this.clients.get(p.get("client_id") ?? "");
    if (!client || client.secret !== p.get("client_secret")) return json(401, { error: "invalid_client", error_description: "Client authentication failed" });
    const grantType = p.get("grant_type");
    let grant: Grant;
    if (grantType === "authorization_code") {
      const code = this.codes.get(p.get("code") ?? "");
      if (!code || code.clientId !== p.get("client_id") || code.redirectUri !== p.get("redirect_uri")) {
        return json(400, { error: "invalid_grant", error_description: "The authorization code is invalid" });
      }
      this.codes.delete(p.get("code")!);
      grant = code.grant;
    } else if (grantType === "refresh_token") {
      const rt = this.refresh.get(p.get("refresh_token") ?? "");
      if (!rt || rt.grant.revoked || rt.grant.clientId !== p.get("client_id")) return json(400, { error: "invalid_grant", error_description: "The refresh token is invalid" });
      if (rt.used) {
        // Reuse of a spent token: revoke the whole grant.
        rt.grant.revoked = true;
        return json(400, { error: "invalid_grant", error_description: "The refresh token has already been used" });
      }
      rt.used = true;
      // Refreshing invalidates the grant's existing access tokens.
      for (const [k, v] of this.access) if (v.grant === rt.grant) this.access.delete(k);
      grant = rt.grant;
    } else {
      return json(400, { error: "unsupported_grant_type" });
    }
    const accessToken = `at-${randomBytes(8).toString("hex")}`;
    this.access.set(accessToken, { grant, expiresAt: this.now() + HOUR });
    const out: Record<string, unknown> = { access_token: accessToken, expires_in: 3600, scope: grant.scope, token_type: "bearer" };
    if (grant.scope.split(" ").includes("offline")) {
      const refreshToken = `rt-${randomBytes(8).toString("hex")}`;
      this.refresh.set(refreshToken, { grant, used: false });
      out.refresh_token = refreshToken;
    }
    return json(200, out);
  }

  private api(url: URL, authorization: string | null): Response {
    const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
    const at = this.access.get(token);
    if (!at || at.grant.revoked || at.expiresAt <= this.now()) return json(401, { message: "Authorization was not valid" });
    const path = url.pathname.slice("/developer".length);
    const q = url.searchParams;
    let m: RegExpExecArray | null;
    if (path === "/v2/user/profile/basic") return json(200, this.profile);
    if (path === "/v2/user/measurement/body") return this.body ? json(200, this.body) : json(404, { message: "not found" });
    if (path === "/v2/cycle") return this.page(this.cycles, q, (r) => r.start, (r) => r.end ?? null);
    if (path === "/v2/recovery") return this.page(this.recoveries, q, (r) => this.sleepOf(r)?.start ?? r.created_at, (r) => this.sleepOf(r)?.end ?? null);
    if (path === "/v2/activity/sleep") return this.page(this.sleeps, q, (r) => r.start, (r) => r.end);
    if (path === "/v2/activity/workout") return this.page(this.workouts, q, (r) => r.start, (r) => r.end);
    if ((m = /^\/v2\/cycle\/(\d+)$/.exec(path))) return this.one(this.cycles.find((c) => c.id === Number(m![1])));
    if ((m = /^\/v2\/cycle\/(\d+)\/sleep$/.exec(path))) return this.one(this.sleeps.find((s) => s.cycle_id === Number(m![1]) && !s.nap));
    if ((m = /^\/v2\/cycle\/(\d+)\/recovery$/.exec(path))) return this.one(this.recoveries.find((r) => r.cycle_id === Number(m![1])));
    if ((m = /^\/v2\/activity\/sleep\/([0-9a-f-]+)$/.exec(path))) return this.one(this.sleeps.find((s) => s.id === m![1]));
    if ((m = /^\/v2\/activity\/workout\/([0-9a-f-]+)$/.exec(path))) return this.one(this.workouts.find((w) => w.id === m![1]));
    return json(404, { message: "not found" });
  }

  private sleepOf(r: Recovery) {
    return this.sleeps.find((s) => s.id === r.sleep_id);
  }

  private one(record: unknown): Response {
    return record ? json(200, record) : json(404, { message: "not found" });
  }

  /** WHOOP's collection semantics: start inclusive, end exclusive (default now), limit ≤ 25 (default 10), newest first. */
  private page<T>(all: T[], q: URLSearchParams, startOf: (r: T) => string, endOf: (r: T) => string | null): Response {
    const limit = q.has("limit") ? Number(q.get("limit")) : 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) return json(400, { message: "limit must be between 1 and 25" });
    const start = q.has("start") ? Date.parse(q.get("start")!) : Number.NEGATIVE_INFINITY;
    const end = q.has("end") ? Date.parse(q.get("end")!) : this.now();
    const matching = all
      .filter((r) => {
        const s = Date.parse(startOf(r));
        const e = endOf(r) ? Date.parse(endOf(r)!) : this.now();
        return e >= start && s < end;
      })
      .sort((a, b) => Date.parse(startOf(b)) - Date.parse(startOf(a)));
    const offset = q.has("nextToken") ? Number(Buffer.from(q.get("nextToken")!, "base64url").toString()) : 0;
    if (!Number.isInteger(offset) || offset < 0) return json(400, { message: "bad nextToken" });
    const records = matching.slice(offset, offset + limit);
    const next = offset + limit < matching.length ? Buffer.from(String(offset + limit)).toString("base64url") : undefined;
    return json(200, next ? { records, next_token: next } : { records });
  }
}
