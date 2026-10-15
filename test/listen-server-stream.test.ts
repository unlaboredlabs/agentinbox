import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSelf } from "../shared/agent-api.ts";
import { agentApi } from "../server/agentapi/index.ts";
import { createApp } from "../server/app.ts";
import { type RunningServer, startServer } from "../server/server.ts";
import { testConfig } from "./helpers.ts";
import { addAccount, emitMessage, fakeMail, readGrant, SseReader } from "./listen-server-helpers.ts";
import { fakeGoogle, fakeIngest } from "./platform-helpers.ts";

let running: RunningServer | undefined;
const readers: SseReader[] = [];
afterEach(async () => {
  for (const r of readers.splice(0)) r.cancel();
  await running?.close();
  if (running) rmSync(running.ctx.config.dataDir, { recursive: true, force: true });
  running = undefined;
});

async function setup(opts: { heartbeatMs?: number } = {}) {
  running = await startServer({ config: testConfig(), overrides: { google: fakeGoogle(), ingest: fakeIngest(), mail: fakeMail() } });
  const { ctx, url } = running;
  agentApi(ctx, { heartbeatMs: opts.heartbeatMs ?? 60_000 });
  addAccount(ctx, "acc_a", "me@acme.com");
  addAccount(ctx, "acc_b", "other@acme.com");
  const { agent, apiKey } = ctx.policy.createAgent({ name: "Hermes", grants: [readGrant("acc_a")] });

  const open = async (query = "", headers: Record<string, string> = {}, key = apiKey) => {
    const res = await fetch(`${url}/agent/v1/events/stream${query}`, { headers: { authorization: `Bearer ${key}`, ...headers } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = new SseReader(res);
    readers.push(reader);
    await reader.until((f) => f.some((x) => x.comment === "connected"));
    return reader;
  };
  const ack = (consumer: string, seq: number, key = apiKey) =>
    fetch(`${url}/agent/v1/events/ack`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ consumer, seq }) });
  return { ctx, url, agent, apiKey, open, ack };
}

const seqs = (r: SseReader) => r.mail().map((m) => m.seq);

describe("GET /agent/v1/events/stream", () => {
  it("sends the backlog then live events, only within the agent's grants and label scope", async () => {
    const s = await setup();
    s.ctx.policy.upsertGrant(s.agent.id, "acc_a", readGrant("acc_a", { labelScope: ["Label_work"] }));
    const visible1 = emitMessage(s.ctx, "acc_a", "m1", ["INBOX", "Label_work"]);
    emitMessage(s.ctx, "acc_a", "m2", ["INBOX"]); // out of scope
    emitMessage(s.ctx, "acc_b", "m3", ["INBOX", "Label_work"]); // ungranted account
    const visible2 = s.ctx.events.emit({ type: "sync.gap", accountId: "acc_a", dedupeKey: "gap1" })!.seq; // account-level: scope-free

    const r = await s.open();
    await r.until(() => r.mail().length >= 2);
    expect(seqs(r)).toEqual([visible1, visible2]);
    const [first] = r.mail();
    expect(first!.payload).toMatchObject({ type: "message.received", data: { seq: visible1, accountId: "acc_a", accountEmail: "me@acme.com", message: { id: "m1" } } });
    expect(first!.payload.timestamp).toBe(first!.payload.data.createdAt);
    expect(first!.payload.data).not.toHaveProperty("threadLabelIds");
    expect(first!.payload.data).not.toHaveProperty("content");

    emitMessage(s.ctx, "acc_b", "m4", ["Label_work"]);
    emitMessage(s.ctx, "acc_a", "m5", ["INBOX"]);
    const live = emitMessage(s.ctx, "acc_a", "m6", ["Label_work"]);
    await r.until(() => r.mail().length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seqs(r)).toEqual([visible1, visible2, live]);

    // Narrowing the scope applies to the next event without reconnecting.
    s.ctx.policy.upsertGrant(s.agent.id, "acc_a", readGrant("acc_a", { labelScope: ["Label_other"] }));
    emitMessage(s.ctx, "acc_a", "m7", ["Label_work"]);
    const other = emitMessage(s.ctx, "acc_a", "m8", ["Label_other"]);
    await r.until(() => r.mail().length >= 4);
    expect(seqs(r)).toEqual([visible1, visible2, live, other]);
  });

  it("filters by type and attaches cleaned content with include_body", async () => {
    const s = await setup();
    emitMessage(s.ctx, "acc_a", "m1", ["SENT"], "message.sent");
    const ok = emitMessage(s.ctx, "acc_a", "m2");
    const failing = emitMessage(s.ctx, "acc_a", "fail3");
    const r = await s.open("?types=message.received&include_body=1");
    await r.until(() => r.mail().length >= 2);
    const [a, b] = r.mail();
    expect([a!.seq, b!.seq]).toEqual([ok, failing]);
    expect(a!.payload.data.content).toMatchObject({ body: "Body of m2", signals: { external: true } });
    expect(b!.payload.data).not.toHaveProperty("content");
    expect(b!.payload.data.contentError).toMatch(/Message body unavailable: Gmail is down/);

    const bad = await fetch(`${s.url}/agent/v1/events/stream?types=bogus`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(bad.status).toBe(400);
    const badConsumer = await fetch(`${s.url}/agent/v1/events/stream?consumer=${encodeURIComponent("a b")}`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(badConsumer.status).toBe(400);
  });

  it("resumes after max(after, Last-Event-ID, the consumer's acked cursor)", async () => {
    const s = await setup();
    const all = ["m1", "m2", "m3", "m4", "m5"].map((id) => emitMessage(s.ctx, "acc_a", id));

    let r = await s.open(`?consumer=laptop&after=${all[1]}`);
    await r.until(() => r.mail().length >= 3);
    expect(seqs(r)).toEqual(all.slice(2));
    r.cancel();

    r = await s.open(`?consumer=laptop&after=${all[0]}`, { "last-event-id": String(all[2]) });
    await r.until(() => r.mail().length >= 2);
    expect(seqs(r)).toEqual(all.slice(3));
    r.cancel();

    expect(await (await s.ack("laptop", all[3]!)).json()).toEqual({ ackedSeq: all[3] });
    r = await s.open("?consumer=laptop", { "last-event-id": String(all[1]) });
    await r.until(() => r.mail().length >= 1);
    expect(seqs(r)).toEqual([all[4]]);

    // Cursors are per consumer.
    const other = await s.open("?consumer=desktop");
    await other.until(() => other.mail().length >= 5);
    expect(seqs(other)).toEqual(all);
  });

  it("tracks listeners on the agent while connected", async () => {
    const s = await setup();
    const r = await s.open("?consumer=laptop", { "user-agent": "agentinbox-listen/1.2.3", "x-agentinbox-client": JSON.stringify({ hostname: "wynn-mbp", platform: "darwin" }) });
    const listeners = s.ctx.policy.getAgent(s.agent.id)!.listeners;
    expect(listeners).toEqual([
      { consumer: "laptop", connected: true, ackedSeq: 0, lastSeenAt: expect.any(String), client: { hostname: "wynn-mbp", platform: "darwin", version: "1.2.3" } },
    ]);
    r.cancel();
    const deadline = Date.now() + 2000;
    while (s.ctx.policy.getAgent(s.agent.id)!.listeners[0]!.connected && Date.now() < deadline) await new Promise((x) => setTimeout(x, 10));
    expect(s.ctx.policy.getAgent(s.agent.id)!.listeners[0]!.connected).toBe(false);
  });

  it("sends heartbeats and re-checks access on each one", async () => {
    const s = await setup({ heartbeatMs: 40 });
    const r = await s.open();
    await r.until((f) => f.filter((x) => x.comment === "ping").length >= 2);
    // Bypass policy (no bus event): only the heartbeat can notice.
    s.ctx.db.run("UPDATE agents SET disabled = 1 WHERE id = ?", s.agent.id);
    const frames = await r.end();
    expect(frames.at(-1)).toEqual({ event: "revoked", data: JSON.stringify({ reason: "agent_disabled" }) });
  });

  const revocations: [string, string, (s: Awaited<ReturnType<typeof setup>>) => void][] = [
    ["disabling the agent", "agent_disabled", (s) => s.ctx.policy.updateAgent(s.agent.id, { disabled: true })],
    ["rotating the key", "key_rotated", (s) => s.ctx.policy.rotateKey(s.agent.id)],
    ["deleting the agent", "agent_deleted", (s) => s.ctx.policy.deleteAgent(s.agent.id)],
    ["deleting the read grant", "no_read_grant", (s) => s.ctx.policy.deleteGrant(s.agent.id, "acc_a")],
    ["removing read from the grant", "no_read_grant", (s) => s.ctx.policy.upsertGrant(s.agent.id, "acc_a", readGrant("acc_a", { capabilities: ["draft"] }))],
  ];
  for (const [what, reason, revoke] of revocations) {
    it(`closes a live stream with event: revoked on ${what}`, async () => {
      const s = await setup();
      const r = await s.open();
      const started = performance.now();
      revoke(s);
      const frames = await r.end(1000);
      expect(performance.now() - started).toBeLessThan(100);
      expect(frames.at(-1)).toEqual({ event: "revoked", data: JSON.stringify({ reason }) });
      // Nothing more is delivered on a revoked stream, and the agent's listener shows disconnected.
      expect(s.ctx.bus.listenerCount("agent")).toBe(0);
    });
  }

  it("keeps a stream open on unrelated agent changes", async () => {
    const s = await setup();
    const other = s.ctx.policy.createAgent({ name: "Other", grants: [readGrant("acc_a")] });
    const r = await s.open();
    s.ctx.policy.rotateKey(other.agent.id);
    s.ctx.policy.updateAgent(s.agent.id, { name: "Renamed" });
    const seq = emitMessage(s.ctx, "acc_a", "m1");
    await r.until(() => r.mail().length >= 1);
    expect(seqs(r)).toEqual([seq]);
    expect(r.ended).toBe(false);
  });

  it("refuses to open without a read grant", async () => {
    const s = await setup();
    s.ctx.policy.deleteGrant(s.agent.id, "acc_a");
    const res = await fetch(`${s.url}/agent/v1/events/stream`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_read_grant");
  });
});

describe("POST /agent/v1/events/ack", () => {
  it("only moves the cursor forward and never past the newest event", async () => {
    const s = await setup();
    const a = emitMessage(s.ctx, "acc_a", "m1");
    const b = emitMessage(s.ctx, "acc_a", "m2");
    expect(await (await s.ack("laptop", b)).json()).toEqual({ ackedSeq: b });
    expect(await (await s.ack("laptop", a)).json()).toEqual({ ackedSeq: b });
    expect(await (await s.ack("laptop", b + 1000)).json()).toEqual({ ackedSeq: b });
    expect(await (await s.ack("desktop", a)).json()).toEqual({ ackedSeq: a });
    expect((await s.ack("laptop", -1)).status).toBe(400);
    expect(s.ctx.policy.getAgent(s.agent.id)!.listeners.map((l) => [l.consumer, l.ackedSeq])).toEqual([
      ["desktop", a],
      ["laptop", b],
    ]);
    // MCP's cursor is separate.
    expect(s.ctx.events.feed(s.agent.id).ackedSeq).toBe(0);
  });
});

describe("agent API auth", () => {
  it("returns AgentSelf for a valid key and 401 with WWW-Authenticate otherwise", async () => {
    const s = await setup();
    const me = await fetch(`${s.url}/agent/v1/me`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(me.status).toBe(200);
    const self = (await me.json()) as AgentSelf;
    const base = s.ctx.settings.publicUrl();
    expect(self).toEqual({
      id: s.agent.id,
      name: "Hermes",
      grants: [{ accountId: "acc_a", accountEmail: "me@acme.com", capabilities: ["read", "draft"], labelScope: null, sendMode: "draft_only" }],
      mcpUrl: `${base}/mcp`,
      skillUrl: `${base}/skill.md`,
    });
    for (const headers of [{}, { authorization: "Bearer aib_wrong" }]) {
      const res = await fetch(`${s.url}/agent/v1/events/stream`, { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    }
    // No CSRF header needed for a bearer POST.
    expect((await s.ack("x", 0)).status).toBe(200);
  });

  it("locks out an address after 5 distinct bad keys without affecting other addresses", async () => {
    const s = await setup();
    s.ctx.config.trustProxy = true;
    const app = createApp(s.ctx);
    const me = (ip: string, key: string) => app.request("/agent/v1/me", { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": ip } });
    // Retrying the same stale key counts once.
    for (let i = 0; i < 6; i++) expect((await me("10.0.0.1", "aib_stale")).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await me("10.0.0.1", `aib_bad${i}`)).status).toBe(401);
    expect((await me("10.0.0.1", s.apiKey)).status).toBe(200);
    expect((await me("10.0.0.1", "aib_bad4")).status).toBe(401);
    const locked = await me("10.0.0.1", s.apiKey);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    expect((await me("10.0.0.2", s.apiKey)).status).toBe(200);
    expect(s.ctx.audit.list({ action: "agent_api.auth" }).items).toMatchObject([{ outcome: "denied", reason: "lockout", detail: { ip: "10.0.0.1" } }]);
  });
});
