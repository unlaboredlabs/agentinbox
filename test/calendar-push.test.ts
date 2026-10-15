import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import { CALENDAR_PUSH_PATH, createCalendarPush, pushAddress, type CalendarPush } from "../server/calendar/push.ts";
import type { AppContext } from "../server/context.ts";
import { sha256 } from "../server/crypto.ts";
import { now } from "../server/db/index.ts";
import type { LookupFn } from "../server/webhooks/ssrf.ts";
import { consent, type FakeChannel, fakeCalendar } from "./calendar-setup-fakes.ts";
import { FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const ME = "me@example.com";
const TEAM = "team@group.calendar.google.com";
const PUBLIC = "https://inbox.example.com";

const resolveTo =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("pushAddress: only public https", () => {
  it.each([
    ["http://inbox.example.com", resolveTo("93.184.216.34")],
    ["https://inbox.example.com", resolveTo("10.0.0.5")],
    ["https://inbox.example.com", resolveTo("93.184.216.34", "192.168.1.2")],
    ["https://inbox.example.com", resolveTo("100.101.102.103")], // Tailscale (CGNAT)
    ["https://inbox.example.com", resolveTo("fd7a:115c:a1e0::1")],
    ["https://inbox.example.com", resolveTo()],
    ["https://box.tail1234.ts.net", resolveTo("93.184.216.34")],
    ["https://inbox.local", resolveTo("93.184.216.34")],
    ["https://inbox.corp.internal", resolveTo("93.184.216.34")],
    ["https://localhost:8425", resolveTo("93.184.216.34")],
    ["https://127.0.0.1:8425", resolveTo()],
    ["https://inbox.example.com", (async () => Promise.reject(new Error("ENOTFOUND"))) as LookupFn],
  ])("%s → polling", async (url, lookup) => {
    expect(await pushAddress(url, lookup)).toBeNull();
  });

  it("uses publicUrl (with its path) for public https", async () => {
    expect(await pushAddress(PUBLIC, resolveTo("93.184.216.34"))).toBe(`${PUBLIC}${CALENDAR_PUSH_PATH}`);
    expect(await pushAddress("https://example.com/agentinbox", resolveTo("2606:2800:220:1::1"))).toBe(`https://example.com/agentinbox${CALENDAR_PUSH_PATH}`);
    expect(await pushAddress("https://93.184.216.34", resolveTo())).toBe(`https://93.184.216.34${CALENDAR_PUSH_PATH}`);
  });
});

describe("push channels", () => {
  let fake: FakeGoogle;
  let ctx: AppContext;
  let cal: ReturnType<typeof fakeCalendar>;
  let push: CalendarPush;
  let accountId: string;
  let dispose: () => Promise<void>;
  let lookup: LookupFn;

  const make = (verifyTimeoutMs = 60_000) => createCalendarPush(ctx, { lookup: (h) => lookup(h), verifyTimeoutMs });
  const rows = () => ctx.db.all<Record<string, string | null>>("SELECT * FROM calendar_sync WHERE account_id = ? ORDER BY calendar_id", accountId);
  const notify = (ch: FakeChannel, state: string, patch: Record<string, string> = {}) =>
    push.handlePush(
      new Headers({ "x-goog-channel-id": ch.id, "x-goog-channel-token": ch.token, "x-goog-resource-id": ch.resourceId, "x-goog-resource-state": state, ...patch }),
    );

  beforeEach(async () => {
    fake = await startFakeGoogle();
    const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
    ctx = t.ctx;
    dispose = t.dispose;
    cal = fakeCalendar(ctx);
    lookup = resolveTo("93.184.216.34");
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    accountId = (await consent(ctx, fake, ME)).account!.id;
    for (const id of [ME, TEAM]) ctx.db.run("INSERT INTO calendar_sync (account_id, calendar_id, updated_at) VALUES (?, ?, ?)", accountId, id, now());
    ctx.settings.update({ publicUrl: PUBLIC });
    push = make();
  });

  afterEach(async () => {
    await push.stop?.();
    await dispose();
    await fake.close();
  });

  it("creates one channel per synced calendar for public https, storing only the token's hash", async () => {
    await push.reconcile();
    expect(cal.channels.map((c) => [c.calendarId, c.address, c.ttlSeconds])).toEqual([
      [ME, `${PUBLIC}${CALENDAR_PUSH_PATH}`, 604_800],
      [TEAM, `${PUBLIC}${CALENDAR_PUSH_PATH}`, 604_800],
    ]);
    const [ch] = cal.channels;
    expect(ch!.id).toMatch(/^chn_[0-9a-f]{8}_[0-9a-z]{20}$/);
    expect(ch!.token.length).toBeLessThanOrEqual(256);
    const [row] = rows().filter((r) => r.calendar_id === ME);
    expect(row).toMatchObject({ channel_id: ch!.id, channel_resource_id: ch!.resourceId, channel_token_hash: sha256(ch!.token), channel_verified_at: null });
    expect(JSON.stringify(rows())).not.toContain(ch!.token);
    expect(Date.parse(row!.channel_expires_at!) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    // Nothing to do on a second pass.
    await push.reconcile();
    expect(cal.channels).toHaveLength(2);
  });

  it("creates nothing on tailnet / http installs, and stops channels when publicUrl stops being public", async () => {
    lookup = resolveTo("100.101.102.103");
    await push.reconcile();
    expect(cal.channels).toEqual([]);
    lookup = resolveTo("93.184.216.34");
    await push.reconcile();
    expect(cal.channels).toHaveLength(2);
    ctx.settings.update({ publicUrl: "http://inbox.example.com" });
    await push.reconcile();
    expect(cal.stopped.map((s) => s.id).sort()).toEqual(cal.channels.map((c) => c.id).sort());
    expect(rows().every((r) => r.channel_id === null)).toBe(true);
  });

  it("skips accounts without every calendar scope", async () => {
    ctx.db.run("UPDATE accounts SET scopes = ? WHERE id = ?", JSON.stringify(["https://www.googleapis.com/auth/gmail.modify"]), accountId);
    await push.reconcile();
    expect(cal.channels).toEqual([]);
  });

  it("verifies on Google's sync, kicks the calendar on changes, and ignores unknown channels and bad tokens", async () => {
    const kick = vi.spyOn(ctx.calendar, "kick");
    await push.reconcile();
    const ch = cal.channels.find((c) => c.calendarId === TEAM)!;
    expect(push.handlePush(new Headers({ "x-goog-channel-id": "chn_nope", "x-goog-channel-token": ch.token, "x-goog-resource-state": "exists" }))).toBe(404);
    expect(notify(ch, "exists", { "x-goog-channel-token": "guess" })).toBe(404);
    expect(notify(ch, "exists", { "x-goog-channel-token": "" })).toBe(404);
    expect(notify(ch, "exists", { "x-goog-resource-id": "res_other" })).toBe(404);
    expect(kick).not.toHaveBeenCalled();

    expect(notify(ch, "sync")).toBe(204);
    expect(kick).not.toHaveBeenCalled();
    expect(rows().find((r) => r.calendar_id === TEAM)!.channel_verified_at).not.toBeNull();
    expect(ctx.calendar.setupState().accounts[0]).toMatchObject({ push: true, syncedCalendars: 2 });

    expect(notify(ch, "exists")).toBe(204);
    expect(notify(ch, "not_exists")).toBe(204);
    expect(kick.mock.calls).toEqual([
      [accountId, TEAM],
      [accountId, TEAM],
    ]);
  });

  it("is mounted unauthenticated at POST /google/calendar/push", async () => {
    await push.reconcile();
    const ch = cal.channels[0]!;
    const app = createApp(ctx);
    const headers = { "x-goog-channel-id": ch.id, "x-goog-channel-token": ch.token, "x-goog-resource-id": ch.resourceId, "x-goog-resource-state": "sync" };
    const ok = await app.request(CALENDAR_PUSH_PATH, { method: "POST", headers });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("content-security-policy")).toBeTruthy();
    expect((await app.request(CALENDAR_PUSH_PATH, { method: "POST", headers: { ...headers, "x-goog-channel-token": "x" } })).status).toBe(404);
    expect((await app.request(CALENDAR_PUSH_PATH, { method: "POST", headers, body: "x".repeat(10_000) })).status).toBe(413);
    // Not a console route.
    expect((await app.request(CALENDAR_PUSH_PATH)).status).toBe(404);
  });

  it("accepts Google's sync notification even when it arrives before events.watch returns", async () => {
    cal.onWatch = (ch) => expect(notify(ch, "sync")).toBe(204);
    await push.reconcile();
    expect(rows().every((r) => r.channel_verified_at !== null)).toBe(true);
  });

  it("renews a channel with less than a day left: the new one first, then stops the old one", async () => {
    await push.reconcile();
    const old = cal.channels.find((c) => c.calendarId === ME)!;
    expect(notify(old, "sync")).toBe(204);
    ctx.db.run("UPDATE calendar_sync SET channel_expires_at = ? WHERE channel_id = ?", new Date(Date.now() + 3_600_000).toISOString(), old.id);
    await push.reconcile();
    const fresh = cal.channels.filter((c) => c.calendarId === ME).at(-1)!;
    expect(fresh.id).not.toBe(old.id);
    expect(cal.stopped).toEqual([{ id: old.id, resourceId: old.resourceId }]);
    expect(rows().find((r) => r.calendar_id === ME)).toMatchObject({ channel_id: fresh.id, channel_verified_at: null });
    // The old channel is gone for us too.
    expect(notify(old, "exists")).toBe(404);
  });

  it("falls back to polling when Google's sync notification never arrives, until publicUrl changes", async () => {
    await push.stop?.();
    push = make(30);
    await push.reconcile();
    expect(cal.channels).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 60));
    await push.reconcile();
    expect(cal.stopped).toHaveLength(2);
    expect(rows().every((r) => r.channel_id === null)).toBe(true);
    await push.reconcile();
    expect(cal.channels).toHaveLength(2);

    push.start?.();
    ctx.settings.update({ publicUrl: "https://mail.example.com" });
    await vi.waitFor(() => expect(cal.channels).toHaveLength(4));
    expect(cal.channels[2]!.address).toBe(`https://mail.example.com${CALENDAR_PUSH_PATH}`);
  });

  it("replaces channels that point at an old publicUrl (changed while agentinbox was stopped)", async () => {
    await push.reconcile();
    for (const ch of cal.channels) notify(ch, "sync");
    ctx.settings.update({ publicUrl: "https://mail.example.com" });
    await push.stop?.();
    push = make();
    await push.reconcile();
    expect(cal.channels.slice(2).map((c) => c.address)).toEqual([`https://mail.example.com${CALENDAR_PUSH_PATH}`, `https://mail.example.com${CALENDAR_PUSH_PATH}`]);
    expect(cal.stopped).toHaveLength(2);
  });

  it("stays on polling when Google refuses the address", async () => {
    cal.failWatch(new Error("Unauthorized WebHook callback channel"));
    await push.reconcile();
    expect(rows().every((r) => r.channel_id === null)).toBe(true);
    cal.failWatch(null);
    await push.reconcile();
    expect(cal.channels).toEqual([]);
  });

  it("stops an account's channels before the account is removed", async () => {
    await push.reconcile();
    await ctx.accounts.remove(accountId);
    expect(cal.stopped.map((s) => s.id).sort()).toEqual(cal.channels.map((c) => c.id).sort());
    expect(fake.revoked).toHaveLength(1);
  });
});
