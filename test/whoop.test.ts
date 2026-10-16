import { describe, expect, it } from "vitest";
import { type NativeSourceDeps, SourceError, type StoredTokens, type ToolSource } from "../server/broker/types.ts";
import { presetById, presets } from "../server/integrations/index.ts";
import { WHOOP_SCOPES } from "../server/integrations/whoop/api.ts";
import { SIGNATURE_TOLERANCE_MS, type WhoopWebhookDeps, createWhoopEvents, verifyWhoopSignature } from "../server/integrations/whoop/events.ts";
import { authorizeUrl, checkClient, exchangeCode, whoopPreset, whoopRefreshFn, whoopUserIdFrom } from "../server/integrations/whoop/index.ts";
import { WHOOP_TOOLS } from "../server/integrations/whoop/tools.ts";
import { FAKE_REDIRECT, FAKE_WHOOP_CLIENT, FakeWhoop } from "./fake-whoop.ts";

const STATE = "st4te-0123456789";
const CLIENT_RECORD = { client_id: FAKE_WHOOP_CLIENT.clientId, client_secret: FAKE_WHOOP_CLIENT.clientSecret };
const silent = { info() {}, warn() {} };
const signal = () => new AbortController().signal;
const ctx = (connectionId = "conn1") => ({ agentId: "agent1", connectionId, signal: signal(), auditDetail: {} });

/** Mutable clock shared by the fake and the code under test. */
function clock(start = Date.parse("2026-10-16T12:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function connectFull(fake: FakeWhoop) {
  const back = new URL(fake.approve(authorizeUrl({ clientId: FAKE_WHOOP_CLIENT.clientId, redirectUri: FAKE_REDIRECT, state: STATE })));
  expect(back.searchParams.get("state")).toBe(STATE);
  return exchangeCode(back.searchParams.get("code")!, { id: "conn1", redirectUri: FAKE_REDIRECT, client: CLIENT_RECORD }, { fetch: fake.fetch, now: fake.now });
}
const connect = async (fake: FakeWhoop): Promise<StoredTokens> => (await connectFull(fake)).tokens;

/**
 * NativeSourceDeps with a minimal stand-in for the TokenRefresher: single-flight, proactive refresh 60 s before expiry.
 * (Without single-flight, concurrent calls would spend the same refresh token twice and WHOOP revokes the grant.)
 */
async function connected(fake: FakeWhoop) {
  let tokens = await connect(fake);
  fake.requests = []; // count only what happens after connecting
  const refresh = whoopRefreshFn(FAKE_WHOOP_CLIENT, { fetch: fake.fetch, now: fake.now });
  let inflight: Promise<StoredTokens> | null = null;
  const deps: NativeSourceDeps = {
    connectionId: "conn1",
    fetch: fake.fetch,
    log: silent,
    async accessToken(s) {
      if (tokens.expiresAt !== null && tokens.expiresAt - 60_000 <= fake.now()) {
        inflight ??= refresh(tokens, s).finally(() => (inflight = null));
        tokens = await inflight;
      }
      return tokens.accessToken;
    },
  };
  return { deps, tokens: () => tokens };
}

const textOf = (r: { content: { type: string; [k: string]: unknown }[] }) => r.content.map((c) => c.text).join("\n");

describe("WHOOP preset", () => {
  it("is native, user_app OAuth with every scope, and classifies everything as read", () => {
    const p = presetById("whoop")!;
    expect(presets()).toContain(p);
    expect(p.kind).toBe("native");
    expect(p.auth).toEqual({
      type: "user_app",
      authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
      tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
      scopes: ["read:recovery", "read:cycles", "read:workout", "read:sleep", "read:profile", "read:body_measurement", "offline"],
      clientIdInput: "client_id",
      clientSecretInput: "client_secret",
    });
    for (const t of WHOOP_TOOLS) expect(p.classify(t)).toEqual({ risky: false, read: true, source: "preset" });
    expect(p.events?.types).toEqual(["whoop.recovery_updated", "whoop.recovery_deleted", "whoop.sleep_updated", "whoop.sleep_deleted", "whoop.workout_updated", "whoop.workout_deleted"]);
    expect(p.events?.pollIntervalMs).toBe(15 * 60_000);
  });
});

describe("WHOOP OAuth", () => {
  it("builds the authorize URL with state and space-separated scopes, and no PKCE", () => {
    const u = new URL(authorizeUrl({ clientId: "cid", redirectUri: FAKE_REDIRECT, state: STATE }));
    expect(u.origin + u.pathname).toBe("https://api.prod.whoop.com/oauth/oauth2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: "code", client_id: "cid", redirect_uri: FAKE_REDIRECT, scope: WHOOP_SCOPES.join(" "), state: STATE });
    expect(() => authorizeUrl({ clientId: "cid", redirectUri: FAKE_REDIRECT, state: "short" })).toThrow(/8 characters/);
  });

  it("exchanges the code with the client secret in the form body", async () => {
    const c = clock();
    const fake = new FakeWhoop({ now: c.now });
    const { tokens, client } = await connectFull(fake);
    expect(tokens).toMatchObject({ refreshToken: expect.stringMatching(/^rt-/), expiresAt: c.now() + 3_600_000, scope: WHOOP_SCOPES.join(" "), issuer: null });
    expect(fake.tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", redirect_uri: FAKE_REDIRECT, client_id: FAKE_WHOOP_CLIENT.clientId, client_secret: FAKE_WHOOP_CLIENT.clientSecret });
    expect(fake.tokenRequests[0]).not.toHaveProperty("code_verifier");
    // The connected member is recorded from the profile, for the caller to store (setClient) next to the app.
    expect(client).toEqual({ ...CLIENT_RECORD, whoop_user_id: 10129 });
    expect(whoopUserIdFrom(client)).toBe("10129");
    expect(fake.requests).toContain("GET /developer/v2/user/profile/basic");
  });

  it("fails the connect when the profile can't be read", async () => {
    const fake = new FakeWhoop();
    const back = new URL(fake.approve(authorizeUrl({ clientId: FAKE_WHOOP_CLIENT.clientId, redirectUri: FAKE_REDIRECT, state: STATE })));
    const originalFetch = fake.fetch;
    const noProfile: typeof fetch = async (input, init) =>
      String(input).includes("/v2/user/profile/basic") ? new Response("{}", { status: 404 }) : originalFetch(input, init);
    await expect(exchangeCode(back.searchParams.get("code")!, { id: "c", redirectUri: FAKE_REDIRECT, client: CLIENT_RECORD }, { fetch: noProfile })).rejects.toMatchObject({ code: "protocol" });
  });

  it("refuses a grant without offline (no refresh token)", async () => {
    const fake = new FakeWhoop();
    const back = new URL(fake.approve(authorizeUrl({ clientId: FAKE_WHOOP_CLIENT.clientId, redirectUri: FAKE_REDIRECT, state: STATE, scopes: ["read:recovery"] })));
    await expect(exchangeCode(back.searchParams.get("code")!, { id: "c", redirectUri: FAKE_REDIRECT, client: CLIENT_RECORD }, { fetch: fake.fetch })).rejects.toThrow(/offline/);
  });

  it("maps a bad code, a bad secret and missing credentials to needs_reauth", async () => {
    const fake = new FakeWhoop();
    const bad = exchangeCode("nope", { id: "c", redirectUri: FAKE_REDIRECT, client: CLIENT_RECORD }, { fetch: fake.fetch });
    await expect(bad).rejects.toMatchObject({ code: "needs_reauth", message: expect.stringContaining("invalid_grant") });
    const badSecret = exchangeCode("nope", { id: "c", redirectUri: FAKE_REDIRECT, client: { ...CLIENT_RECORD, client_secret: "wrong" } }, { fetch: fake.fetch });
    await expect(badSecret).rejects.toMatchObject({ code: "needs_reauth", message: expect.stringContaining("invalid_client") });
    await expect(exchangeCode("x", { id: "c", redirectUri: FAKE_REDIRECT, client: null }, { fetch: fake.fetch })).rejects.toMatchObject({ code: "needs_reauth" });
  });

  it("rotates the refresh token on every refresh; reusing a spent one is invalid_grant → needs_reauth and revokes the grant", async () => {
    const c = clock();
    const fake = new FakeWhoop({ now: c.now });
    const first = await connect(fake);
    const refresh = whoopRefreshFn(FAKE_WHOOP_CLIENT, { fetch: fake.fetch, now: c.now });
    c.advance(3_600_000);
    const second = await refresh(first, signal());
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.expiresAt).toBe(c.now() + 3_600_000);
    expect(fake.tokenRequests.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: first.refreshToken, client_secret: FAKE_WHOOP_CLIENT.clientSecret, scope: "offline" });
    const third = await refresh(second, signal());
    expect(third.refreshToken).not.toBe(second.refreshToken);

    const reuse = refresh(first, signal());
    await expect(reuse).rejects.toBeInstanceOf(SourceError);
    await expect(refresh(first, signal())).rejects.toMatchObject({ code: "needs_reauth" });
    // The reuse revoked the whole grant, including the newest refresh token.
    await expect(refresh(third, signal())).rejects.toMatchObject({ code: "needs_reauth" });
  });

  it("a 429 on the token endpoint is rate_limited with WHOOP's reset", async () => {
    const fake = new FakeWhoop();
    const tokens = await connect(fake);
    fake.rateLimitNext(1, "12");
    await expect(whoopRefreshFn(FAKE_WHOOP_CLIENT, { fetch: fake.fetch })(tokens, signal())).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 12_000 });
  });

  it("checks pasted credentials live", async () => {
    const fake = new FakeWhoop();
    expect(await checkClient(FAKE_WHOOP_CLIENT, FAKE_REDIRECT, { fetch: fake.fetch })).toBe("ok");
    expect(await checkClient({ ...FAKE_WHOOP_CLIENT, clientSecret: "wrong" }, FAKE_REDIRECT, { fetch: fake.fetch })).toBe("invalid_client");
    expect(await checkClient({ ...FAKE_WHOOP_CLIENT, clientId: "nobody" }, FAKE_REDIRECT, { fetch: fake.fetch })).toBe("invalid_client");
  });
});

describe("WHOOP tools", () => {
  async function source(fake: FakeWhoop): Promise<ToolSource> {
    const { deps } = await connected(fake);
    return whoopPreset({ now: fake.now }).createSource!(deps);
  }

  it("lists the seven pre-pinned, deterministic definitions", async () => {
    const fake = new FakeWhoop();
    const src = await source(fake);
    const listing = await src.listTools(signal());
    expect(listing.tools.map((t) => t.name)).toEqual(["get_today", "get_recovery", "get_sleep", "get_cycles", "get_workouts", "get_profile", "get_body"]);
    expect(listing.tools).toEqual(WHOOP_TOOLS);
    expect(JSON.stringify((await source(new FakeWhoop())).listTools(signal()))).toBe(JSON.stringify(src.listTools(signal())));
    for (const t of listing.tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(fake.requests.filter((r) => r.startsWith("GET"))).toEqual([]);
  });

  it("get_today: recovery, last night's sleep and strain in one summary", async () => {
    const fake = new FakeWhoop();
    const r = await (await source(fake)).callTool("get_today", {}, ctx());
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe(
      [
        "Today: cycle 93010, started 2026-10-16 08:00 (ongoing).",
        "Recovery: recovery 60%, resting heart rate 52 beats per minute, heart rate variability (RMSSD) 65.3 milliseconds, blood oxygen 96.4%, skin temperature 33.7 degrees Celsius.",
        "Last night's sleep: 2026-10-16 00:00 to 2026-10-16 08:00, 7 hours 30 minutes asleep of 8 hours in bed; performance 88%; efficiency 94%; consistency 79%; respiratory rate 15.2 breaths per minute; light 4 hours, deep (slow wave) 1 hour 30 minutes, REM 2 hours, awake 30 minutes; 4 sleep cycles, 3 disturbances; sleep needed 8 hours 30 minutes.",
        "Strain so far: strain 8 (of 21), 8,000 kilojoules (1,912 kilocalories), average heart rate 68 beats per minute, max heart rate 150 beats per minute.",
      ].join("\n"),
    );
    expect(r.structuredContent).toMatchObject({ cycle: { id: 93010 }, recovery: { cycle_id: 93010 }, sleep: { cycle_id: 93010 } });
    expect(fake.requests.filter((q) => q.startsWith("GET"))).toEqual(["GET /developer/v2/cycle?limit=1", "GET /developer/v2/cycle/93010/recovery", "GET /developer/v2/cycle/93010/sleep"]);
  });

  it("get_today before any data", async () => {
    const fake = new FakeWhoop({ days: 0 });
    const r = await (await source(fake)).callTool("get_today", {}, ctx());
    expect(textOf(r)).toMatch(/No WHOOP data yet/);
  });

  it("get_recovery defaults to the last 7 days, newest first", async () => {
    const fake = new FakeWhoop();
    const r = await (await source(fake)).callTool("get_recovery", {}, ctx());
    const lines = textOf(r).split("\n");
    expect(lines[0]).toBe("7 recoveries from 2026-10-09 12:00 UTC to now, newest first:");
    expect(lines[1]!).toMatch(/^- cycle 93010, sleep 00051ee9-0000-4000-8000-00000000000a \(recorded 2026-10-16 06:10 UTC\): recovery 60%/);
    expect((r.structuredContent as { records: unknown[]; nextToken: unknown }).nextToken).toBeNull();
    expect(fake.requests).toContain("GET /developer/v2/recovery?start=2026-10-09T12%3A00%3A00.000Z&limit=25");
  });

  it("get_recovery by sleepId (as in events) and by cycleId", async () => {
    const fake = new FakeWhoop();
    const src = await source(fake);
    const bySleep = await src.callTool("get_recovery", { sleepId: fake.sleeps[2]!.id }, ctx());
    expect(textOf(bySleep)).toContain(`cycle ${fake.sleeps[2]!.cycle_id}`);
    const byCycle = await src.callTool("get_recovery", { cycleId: 93005 }, ctx());
    expect(textOf(byCycle)).toContain("recovery 65%");
    const missing = await src.callTool("get_recovery", { sleepId: "00000000-0000-4000-8000-000000000000" }, ctx());
    expect(missing.isError).toBe(true);
  });

  it("get_sleep lists and fetches by id", async () => {
    const fake = new FakeWhoop();
    const src = await source(fake);
    const r = await src.callTool("get_sleep", { start: "2026-10-14", end: "2026-10-15" }, ctx());
    // WHOOP's start is "after or during": the sleep that began the evening before the 14th overlaps it.
    expect(textOf(r).split("\n")[0]).toBe("3 sleeps from 2026-10-14 00:00 UTC to 2026-10-16 00:00 UTC, newest first:");
    expect(textOf(r)).toContain("- 2026-10-15 00:00 to 2026-10-15 08:00, sleep ");
    const one = await src.callTool("get_sleep", { id: fake.sleeps[0]!.id }, ctx());
    expect(textOf(one)).toContain("7 hours 30 minutes asleep");
  });

  it("sleep needed sums every component; the nap credit is already negative", async () => {
    const fake = new FakeWhoop();
    const napped = fake.sleeps[1]!;
    expect(napped.score!.sleep_needed.need_from_recent_nap_milli).toBe(-45 * 60_000);
    const r = await (await source(fake)).callTool("get_sleep", { id: napped.id }, ctx());
    // 8 h baseline + 20 min debt + 10 min strain − 45 min nap.
    expect(textOf(r)).toContain("; sleep needed 7 hours 45 minutes");
  });

  it("get_cycles, get_workouts, get_profile and get_body", async () => {
    const fake = new FakeWhoop();
    const src = await source(fake);
    const cycles = textOf(await src.callTool("get_cycles", { limit: 2 }, ctx()));
    expect(cycles).toContain("- 2026-10-16 08:00 to now (ongoing), cycle 93010: strain 8 (of 21)");
    expect(cycles).toContain("- 2026-10-15 08:00 to 2026-10-16 08:00, cycle 93009");
    expect(cycles).toContain('More available: call again with nextToken "');
    const workouts = textOf(await src.callTool("get_workouts", {}, ctx()));
    expect(workouts).toContain(
      "- 2026-10-15 18:00, running, 52 minutes, workout 000030c0-0000-4000-8000-000000000009: strain 12.3, 2,100 kilojoules (502 kilocalories), average heart rate 151 beats per minute, max heart rate 178 beats per minute, distance 8,204 meters, climbed 61 meters, minutes in heart rate zones 0 to 5: 1, 5, 20, 18, 7, 1",
    );
    const byId = await src.callTool("get_workouts", { id: fake.workouts[0]!.id }, ctx());
    expect(byId.structuredContent).toMatchObject({ records: [{ id: fake.workouts[0]!.id }] });
    const profile = await src.callTool("get_profile", {}, ctx());
    expect(textOf(profile)).toBe("WHOOP member Jay Nay (jaynay@example.com), user id 10129.");
    expect(profile.structuredContent).toEqual(fake.profile);
    expect(textOf(await src.callTool("get_body", {}, ctx()))).toBe("Height 1.83 meters, weight 90.7 kilograms, max heart rate 200 beats per minute.");
    fake.body = null;
    expect((await src.callTool("get_body", {}, ctx())).isError).toBe(true);
  });

  it("paginates across WHOOP's 25-record pages and continues with nextToken", async () => {
    const fake = new FakeWhoop({ days: 40 });
    const src = await source(fake);
    const range = { start: "2026-09-01", end: "2026-10-16" };
    const first = await src.callTool("get_cycles", { ...range, limit: 30 }, ctx());
    const s1 = first.structuredContent as { records: { id: number }[]; nextToken: string };
    expect(s1.records).toHaveLength(30);
    expect(s1.nextToken).toBeTruthy();
    expect(fake.requests.filter((r) => r.startsWith("GET /developer/v2/cycle?")).map((r) => new URL(`https://x${r.slice(4)}`).searchParams.get("limit"))).toEqual(["25", "5"]);
    const second = await src.callTool("get_cycles", { ...range, limit: 30, nextToken: s1.nextToken }, ctx());
    const s2 = second.structuredContent as { records: { id: number }[]; nextToken: string | null };
    expect(s2.records).toHaveLength(10);
    expect(s2.nextToken).toBeNull();
    const ids = [...s1.records, ...s2.records].map((r) => r.id);
    expect(new Set(ids).size).toBe(40);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("a 429 is SourceError rate_limited with retryAfter from X-RateLimit-Reset", async () => {
    const fake = new FakeWhoop();
    const src = await source(fake);
    fake.rateLimitNext(1, "42");
    const err = await src.callTool("get_profile", {}, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ code: "rate_limited", retryAfterMs: 42_000 });
  });

  it("refreshes an expired access token and keeps working; a revoked grant is needs_reauth", async () => {
    const c = clock();
    const fake = new FakeWhoop({ now: c.now });
    const { deps, tokens } = await connected(fake);
    const src = createWhoopSourceFor(deps, c.now);
    const before = tokens().refreshToken;
    c.advance(2 * 3_600_000);
    expect((await src.callTool("get_profile", {}, ctx())).isError).toBeUndefined();
    expect(tokens().refreshToken).not.toBe(before);

    // Access token invalidated at WHOOP with nothing new to try: needs re-auth.
    fake.expireAccessTokens();
    await expect(src.callTool("get_profile", {}, ctx())).rejects.toMatchObject({ code: "needs_reauth" });
  });

  it("bad arguments and unknown tools are tool errors, not throws", async () => {
    const src = await source(new FakeWhoop());
    for (const [name, args] of [
      ["get_sleep", { start: "yesterday" }],
      ["get_sleep", { start: "2026-10-10", end: "2026-10-01" }],
      ["get_cycles", { limit: 0 }],
      ["get_cycles", { limit: 101 }],
      ["get_cycles", { id: "abc" }],
      ["get_sleep", { id: "../../v2/user/profile/basic" }],
      ["get_nothing", {}],
    ] as const) {
      const r = await src.callTool(name, args as Record<string, unknown>, ctx());
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

const createWhoopSourceFor = (deps: NativeSourceDeps, now: () => number) => whoopPreset({ now }).createSource!(deps);

describe("WHOOP webhooks", () => {
  const T = Date.parse("2026-10-16T12:00:00Z");
  /** The route's deps: the contract's plus the stored client record (with the connected member's id). */
  const hookDeps = (fake: FakeWhoop) =>
    ({
      connectionId: "conn1",
      fetch: fake.fetch,
      log: silent,
      accessToken: async () => "unused",
      clientSecret: FAKE_WHOOP_CLIENT.clientSecret,
      client: { ...CLIENT_RECORD, whoop_user_id: fake.profile.user_id },
    }) as WhoopWebhookDeps;

  it("verifies base64(HMAC-SHA256(timestamp + body)) with a timestamp window", () => {
    const fake = new FakeWhoop();
    const ok = fake.webhook({ type: "recovery.updated", id: "s1", trace_id: "t1" });
    expect(verifyWhoopSignature(ok.headers, ok.rawBody, FAKE_WHOOP_CLIENT.clientSecret, T)).toBe(true);
    expect(verifyWhoopSignature({ ...ok.headers, "X-WHOOP-Signature": ok.headers["x-whoop-signature"] }, ok.rawBody, FAKE_WHOOP_CLIENT.clientSecret, T)).toBe(true);
    expect(verifyWhoopSignature(ok.headers, Buffer.concat([ok.rawBody, Buffer.from(" ")]), FAKE_WHOOP_CLIENT.clientSecret, T)).toBe(false);
    expect(verifyWhoopSignature(ok.headers, ok.rawBody, "other-secret", T)).toBe(false);
    expect(verifyWhoopSignature(ok.headers, ok.rawBody, FAKE_WHOOP_CLIENT.clientSecret, T + SIGNATURE_TOLERANCE_MS + 1)).toBe(false);
    expect(verifyWhoopSignature(ok.headers, ok.rawBody, FAKE_WHOOP_CLIENT.clientSecret, T - SIGNATURE_TOLERANCE_MS - 1)).toBe(false);
    expect(verifyWhoopSignature({ "x-whoop-signature": ok.headers["x-whoop-signature"] }, ok.rawBody, FAKE_WHOOP_CLIENT.clientSecret, T)).toBe(false);
    expect(verifyWhoopSignature({ ...ok.headers, "x-whoop-signature": "AAAA" }, ok.rawBody, FAKE_WHOOP_CLIENT.clientSecret, T)).toBe(false);
    expect(verifyWhoopSignature(ok.headers, ok.rawBody, "", T)).toBe(false);
  });

  it("maps every v2 type to whoop.* events with ids only", async () => {
    const fake = new FakeWhoop();
    const events = createWhoopEvents({ now: () => T });
    const cases: [string, string, Record<string, unknown>][] = [
      ["recovery.updated", "whoop.recovery_updated", { sleepId: "id-1" }],
      ["recovery.deleted", "whoop.recovery_deleted", { sleepId: "id-1" }],
      ["sleep.updated", "whoop.sleep_updated", { sleepId: "id-1" }],
      ["sleep.deleted", "whoop.sleep_deleted", { sleepId: "id-1" }],
      ["workout.updated", "whoop.workout_updated", { workoutId: "id-1" }],
      ["workout.deleted", "whoop.workout_deleted", { workoutId: "id-1" }],
    ];
    for (const [i, [whoopType, type, ids]] of cases.entries()) {
      const out = await events.handleWebhook!(fake.webhook({ type: whoopType, id: "id-1", trace_id: `trace-${i}` }), hookDeps(fake));
      expect(out).toEqual([{ type, connectionId: "conn1", dedupeKey: `whoop:trace-${i}`, data: { ...ids, traceId: `trace-${i}` } }]);
    }
  });

  it("tolerates WHOOP's hour of retries (2 h window); older or future-dated → null", async () => {
    const fake = new FakeWhoop();
    const events = createWhoopEvents({ now: () => T });
    expect(SIGNATURE_TOLERANCE_MS).toBe(2 * 3_600_000);
    const retried = fake.webhook({ type: "sleep.updated", id: "a", trace_id: "late" }, { timestamp: T - 90 * 60_000 });
    expect(await events.handleWebhook!(retried, hookDeps(fake))).toHaveLength(1);
    expect(await events.handleWebhook!(fake.webhook({ type: "sleep.updated", id: "a", trace_id: "x" }, { timestamp: T - 3 * 3_600_000 }), hookDeps(fake))).toBeNull();
    expect(await events.handleWebhook!(fake.webhook({ type: "sleep.updated", id: "a", trace_id: "x" }, { timestamp: T + 3 * 3_600_000 }), hookDeps(fake))).toBeNull();
  });

  it("bad signature → null; unknown types → no events; the handler is stateless (the route dedupes)", async () => {
    const fake = new FakeWhoop();
    const events = createWhoopEvents({ now: () => T });
    expect(await events.handleWebhook!(fake.webhook({ type: "sleep.updated", id: "a", trace_id: "x" }, { secret: "forged" }), hookDeps(fake))).toBeNull();
    const msg = fake.webhook({ type: "sleep.updated", id: "a", trace_id: "dup" });
    expect(await events.handleWebhook!(msg, hookDeps(fake))).toHaveLength(1);
    expect(await events.handleWebhook!(msg, hookDeps(fake))).toHaveLength(1);
    expect(await events.handleWebhook!(fake.webhook({ type: "cycle.updated", id: 1, trace_id: "y" }), hookDeps(fake))).toEqual([]);
  });

  it("drops (validly signed) events for another WHOOP member of the same app, and fails closed without a stored id", async () => {
    const fake = new FakeWhoop();
    const events = createWhoopEvents({ now: () => T });
    const stranger = fake.webhook({ type: "recovery.updated", id: "their-sleep", trace_id: "s1", user_id: 777 });
    expect(await events.handleWebhook!(stranger, hookDeps(fake))).toEqual([]);
    const mine = fake.webhook({ type: "recovery.updated", id: "my-sleep", trace_id: "s2" });
    expect(await events.handleWebhook!(mine, { ...hookDeps(fake), client: CLIENT_RECORD } as never)).toEqual([]);
    expect(await events.handleWebhook!(mine, { ...hookDeps(fake), client: null } as never)).toEqual([]);
    // Stored as a string works too (JSON round trips).
    expect(await events.handleWebhook!(mine, { ...hookDeps(fake), client: { ...CLIENT_RECORD, whoop_user_id: "10129" } } as never)).toHaveLength(1);
  });
});

describe("WHOOP poll", () => {
  it("first poll sets a baseline; later polls emit changed records once", async () => {
    const c = clock();
    const fake = new FakeWhoop({ now: c.now });
    const { deps } = await connected(fake);
    const events = createWhoopEvents({ now: c.now });
    const first = await events.poll!(null, deps);
    expect(first.events).toEqual([]);
    expect(JSON.parse(first.cursor!)).toEqual({ v: 1, since: "2026-10-16T06:30:00.000Z" });

    expect((await events.poll!(first.cursor, deps)).events).toEqual([]);

    // Tomorrow: a new cycle, sleep and recovery are scored, yesterday's run is in, and a pending workout appears.
    c.advance(24 * 3_600_000);
    fake.seed(10);
    fake.workouts.unshift({ ...fake.workouts[0]!, id: "000030c0-0000-4000-8000-0000000000ff", score_state: "PENDING_SCORE", updated_at: new Date(c.now()).toISOString() });
    const next = await events.poll!(first.cursor, deps);
    const sleepId = fake.sleeps[0]!.id;
    expect(next.events.map((e) => [e.type, e.data])).toEqual([
      ["whoop.recovery_updated", { sleepId, cycleId: fake.sleeps[0]!.cycle_id }],
      ["whoop.sleep_updated", { sleepId, cycleId: fake.sleeps[0]!.cycle_id }],
      // Yesterday afternoon's run (updated after the baseline); the pending workout isn't announced yet.
      ["whoop.workout_updated", { workoutId: "000030c0-0000-4000-8000-000000000009" }],
    ]);
    expect(next.events[0]!.dedupeKey).toBe(`whoop:poll:whoop.recovery_updated:${sleepId}:2026-10-17T06:30:00.000Z`);
    expect(JSON.parse(next.cursor!).since).toBe("2026-10-17T06:30:00.000Z");
    expect((await events.poll!(next.cursor, deps)).events).toEqual([]);
    // Three requests per poll: well within 10,000 a day at one poll every 15 minutes.
    expect(fake.requests.filter((r) => r.startsWith("GET")).length).toBe(4 * 3);
  });

  it("a garbage cursor is a fresh baseline; 429 propagates as rate_limited", async () => {
    const fake = new FakeWhoop();
    const { deps } = await connected(fake);
    const events = createWhoopEvents({ now: fake.now });
    expect((await events.poll!("not json", deps)).events).toEqual([]);
    fake.rateLimitNext(3);
    await expect(events.poll!(null, deps)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("WHOOP setup steps", () => {
  const base = { publicUrl: "http://localhost:8425", redirectUri: "http://localhost:8425/oauth/connections/callback" };

  it("without a public https URL: no webhook step, redirect copy, scopes, both inputs", () => {
    const steps = whoopPreset().setupSteps({ ...base, webhookUrl: null });
    expect(steps.map((s) => s.id)).toEqual(["dashboard", "team", "app", "client-id", "client-secret", "connect"]);
    expect(steps[0]!.link?.url).toBe("https://developer-dashboard.whoop.com");
    const app = steps.find((s) => s.id === "app")!;
    expect(app.link?.url).toBe("https://developer-dashboard.whoop.com/apps/create");
    expect(app.copy).toEqual({ label: "Redirect URI", value: base.redirectUri });
    for (const scope of ["read:recovery", "read:cycles", "read:workout", "read:sleep", "read:profile", "read:body_measurement"]) expect(app.body).toContain(`\`${scope}\``);
    expect(app.body).toMatch(/If WHOOP refuses this address/);
    expect(steps.find((s) => s.id === "client-id")!.input).toMatchObject({ key: "client_id" });
    expect(steps.find((s) => s.id === "client-secret")!.input).toMatchObject({ key: "client_secret", secret: true });
    for (const s of steps) {
      expect(s.body).not.toMatch(/[*_#[\]]{2}|^#|\]\(/m); // plain words, `code` only
      if (s.input?.pattern) expect(() => new RegExp(s.input!.pattern!)).not.toThrow();
    }
    const p = whoopPreset();
    const auth = p.auth as { clientIdInput: string; clientSecretInput: string };
    const keys = steps.flatMap((s) => (s.input ? [s.input.key] : []));
    expect(keys).toEqual([auth.clientIdInput, auth.clientSecretInput]);
  });

  it("with a public https URL: an optional webhook step with the URL to copy", () => {
    const webhookUrl = "https://inbox.example.com/hooks/connections/whoop";
    const steps = whoopPreset().setupSteps({ publicUrl: "https://inbox.example.com", redirectUri: "https://inbox.example.com/oauth/connections/callback", webhookUrl });
    expect(steps.map((s) => s.id)).toEqual(["dashboard", "team", "app", "webhook", "client-id", "client-secret", "connect"]);
    const step = steps.find((s) => s.id === "webhook")!;
    expect(step.copy).toEqual({ label: "Webhook URL", value: webhookUrl });
    expect(step.title).toMatch(/^Optional/);
    expect(step.body).toContain("You can skip this: xaq checks WHOOP every 15 minutes");
  });

  it("tailnet-only https URL: no webhook URL anywhere, and the steps say xaq checks every 15 minutes", () => {
    const tailnet = "https://box.tail1234.ts.net";
    const steps = whoopPreset().setupSteps({ publicUrl: tailnet, redirectUri: `${tailnet}/oauth/connections/callback`, webhookUrl: null, funnel: null });
    expect(steps.map((s) => s.id)).toEqual(["dashboard", "team", "app", "client-id", "client-secret", "connect"]);
    expect(JSON.stringify(steps)).not.toContain("/hooks/");
    expect(steps.find((s) => s.id === "connect")!.body).toContain("xaq checks every 15 minutes");
    expect(steps.some((s) => /webhooks? (are|is) (needed|required)/i.test(s.body))).toBe(false);
  });

  it("the Funnel offer: optional, warned, the command and the Funnel webhook URL as copies", () => {
    const tailnet = "https://box.tail1234.ts.net";
    const funnel = {
      port: 8443,
      command: "tailscale funnel --bg --https=8443 --set-path=/hooks/connections http://127.0.0.1:8425/hooks/connections",
      offCommand: "tailscale funnel --https=8443 --set-path=/hooks/connections off",
      webhookUrl: "https://box.tail1234.ts.net:8443/hooks/connections/whoop",
    };
    const steps = whoopPreset().setupSteps({ publicUrl: tailnet, redirectUri: `${tailnet}/oauth/connections/callback`, webhookUrl: null, funnel });
    expect(steps.map((s) => s.id)).toEqual(["dashboard", "team", "app", "funnel", "funnel-webhook", "client-id", "client-secret", "connect"]);
    const offer = steps.find((s) => s.id === "funnel")!;
    expect(offer.title).toMatch(/^Optional/);
    expect(offer.copy).toEqual({ label: "Command", value: funnel.command });
    expect(offer.body).toMatch(/Warning: it makes the webhook path `\/hooks\/connections` on port 8443 reachable from the whole internet/);
    expect(offer.body).toContain(funnel.offCommand);
    expect(steps.find((s) => s.id === "funnel-webhook")!.copy).toEqual({ label: "Webhook URL", value: funnel.webhookUrl });
    // A public webhook URL wins over the offer.
    expect(whoopPreset().setupSteps({ publicUrl: tailnet, redirectUri: "r", webhookUrl: "https://x.example/hooks/connections/whoop", funnel }).map((s) => s.id)).not.toContain("funnel");
  });
});
