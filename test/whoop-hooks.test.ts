import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import type { IntegrationEvent } from "../server/broker/types.ts";
import type { AppContext } from "../server/context.ts";
import { type ConnectionHookHost, HOOK_DEDUPE_TTL_MS, connectionHookRoutes, connectionHookUrl } from "../server/integrations/hooks.ts";
import { whoopPreset } from "../server/integrations/whoop/index.ts";
import { createLogger } from "../server/util/log.ts";
import { FAKE_WHOOP_CLIENT, FakeWhoop } from "./fake-whoop.ts";
import { testContext } from "./helpers.ts";

const silent = { info() {}, warn() {} };

type Msg = { headers: Record<string, string>; rawBody: Buffer };
const post = (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, path: string, msg: Msg) =>
  app.request(path, { method: "POST", headers: msg.headers, body: new Uint8Array(msg.rawBody) });

/** A host serving one WHOOP connection, `conn1`, connected as the fake's member. */
function whoopHost(fake: FakeWhoop, emitted: IntegrationEvent[]): ConnectionHookHost & { failEmits: number } {
  const preset = whoopPreset({ now: fake.now });
  const host = {
    failEmits: 0,
    webhookTarget: (id: string) =>
      id === "conn1"
        ? {
            preset,
            clientSecret: FAKE_WHOOP_CLIENT.clientSecret,
            client: { client_id: FAKE_WHOOP_CLIENT.clientId, client_secret: FAKE_WHOOP_CLIENT.clientSecret, whoop_user_id: fake.profile.user_id },
            deps: { connectionId: id, fetch: fake.fetch, log: silent, accessToken: async () => "unused" },
          }
        : null,
    emit: (events: IntegrationEvent[]) => {
      if (host.failEmits > 0) {
        host.failEmits--;
        throw new Error("outbox unavailable");
      }
      emitted.push(...events);
    },
  };
  return host;
}

describe("POST /hooks/connections/:id", () => {
  let ctx: AppContext;
  let dispose: () => Promise<void>;
  let fake: FakeWhoop;
  let emitted: IntegrationEvent[];
  let host: ReturnType<typeof whoopHost>;
  let flag: boolean;

  beforeEach(() => {
    ({ ctx, dispose } = testContext());
    fake = new FakeWhoop({ now: () => Date.now() });
    emitted = [];
    flag = true;
    const realGet = ctx.settings.get.bind(ctx.settings);
    vi.spyOn(ctx.settings, "get").mockImplementation(() => ({ ...realGet(), brokerUpstreams: flag }));
    host = whoopHost(fake, emitted);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose();
  });

  it("verifies, emits and answers 204, outside admin auth and CSRF; a retry isn't emitted twice", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const msg = fake.webhook({ type: "recovery.updated", id: "sleep-uuid", trace_id: "trace-1" });
    const res = await post(app, "/hooks/connections/conn1", msg);
    expect(res.status).toBe(204);
    expect(emitted).toEqual([
      { type: "whoop.recovery_updated", connectionId: "conn1", dedupeKey: "whoop:trace-1", data: { sleepId: "sleep-uuid", traceId: "trace-1" } },
    ]);
    expect((await post(app, "/hooks/connections/conn1", msg)).status).toBe(204);
    expect(emitted).toHaveLength(1);
  });

  it("a failed emit answers 500 and doesn't mark the trace_id, so WHOOP's retry is delivered", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const msg = fake.webhook({ type: "sleep.updated", id: "s", trace_id: "trace-retry" });
    host.failEmits = 1;
    expect((await post(app, "/hooks/connections/conn1", msg)).status).toBe(500);
    expect(emitted).toEqual([]);
    expect((await post(app, "/hooks/connections/conn1", msg)).status).toBe(204);
    expect(emitted.map((e) => e.dedupeKey)).toEqual(["whoop:trace-retry"]);
  });

  it("another WHOOP member of the same app: acknowledged (204) but nothing emitted", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const delivered: string[] = [];
    const app2 = createApp(ctx, { connectionHooks: { ...host, delivered: (id) => void delivered.push(id) } });
    const stranger = fake.webhook({ type: "workout.updated", id: "their-workout", trace_id: "t-other", user_id: 777 });
    expect((await post(app, "/hooks/connections/conn1", stranger)).status).toBe(204);
    expect((await post(app2, "/hooks/connections/conn1", stranger)).status).toBe(204);
    expect(emitted).toEqual([]);
    expect(delivered).toEqual([]); // says nothing about this connection's own webhooks
  });

  it("401 on a bad signature or a timestamp outside 2 h; nothing emitted", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const forged = fake.webhook({ type: "sleep.updated", id: "a", trace_id: "t" }, { secret: "forged" });
    expect((await post(app, "/hooks/connections/conn1", forged)).status).toBe(401);
    const stale = fake.webhook({ type: "sleep.updated", id: "a", trace_id: "t" }, { timestamp: Date.now() - 3 * 3_600_000 });
    expect((await post(app, "/hooks/connections/conn1", stale)).status).toBe(401);
    expect(emitted).toEqual([]);
  });

  it("404 for an unknown connection, without a host, or with brokerUpstreams off", async () => {
    const msg = fake.webhook({ type: "sleep.updated", id: "a", trace_id: "t" });
    expect((await post(createApp(ctx, { connectionHooks: host }), "/hooks/connections/other", msg)).status).toBe(404);
    expect((await post(createApp(ctx), "/hooks/connections/conn1", msg)).status).toBe(404);
    flag = false;
    expect((await post(createApp(ctx, { connectionHooks: host }), "/hooks/connections/conn1", msg)).status).toBe(404);
    expect(emitted).toEqual([]);
  });

  it("refuses bodies over 16 KB", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const res = await app.request("/hooks/connections/conn1", { method: "POST", body: "x".repeat(17 * 1024), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(413);
    expect(emitted).toEqual([]);
  });

  it("/hooks/connections/whoop (the URL the setup shows): the signature picks the connection, and marks it delivered", async () => {
    const delivered: string[] = [];
    const conn1 = host.webhookTarget("conn1")!;
    const conn2 = { ...conn1, clientSecret: "another-apps-secret", deps: { ...conn1.deps, connectionId: "conn2" } };
    const app = createApp(ctx, {
      connectionHooks: { ...host, presetWebhookTargets: (id) => (id === "whoop" ? [conn2, conn1] : []), delivered: (id) => void delivered.push(id) },
    });
    const msg = fake.webhook({ type: "recovery.updated", id: "sleep-uuid", trace_id: "trace-p" });
    expect((await post(app, "/hooks/connections/whoop", msg)).status).toBe(204);
    expect(emitted).toEqual([expect.objectContaining({ connectionId: "conn1", dedupeKey: "whoop:trace-p" })]);
    expect(delivered).toEqual(["conn1"]);
    expect((await post(app, "/hooks/connections/whoop", fake.webhook({ type: "sleep.updated", id: "a", trace_id: "t" }, { secret: "forged" }))).status).toBe(401);
    expect((await post(app, "/hooks/connections/notion", msg)).status).toBe(404);
    expect(delivered).toEqual(["conn1"]);
  });

  it("Funnel traffic on another host:port than the public URL's only reaches the hooks", async () => {
    ctx.settings.update({ publicUrl: "https://box.tail1234.ts.net" });
    const app = createApp(ctx, { connectionHooks: host });
    const funnel = { "tailscale-funnel-request": "?1", host: "box.tail1234.ts.net:8443" };
    for (const path of ["/", "/api/system", "/mcp", "/agent/v1/events", "/hooks/connections"]) {
      const res = await app.request(path, { headers: funnel });
      expect(res.status, path).toBe(404);
    }
    const msg = fake.webhook({ type: "sleep.updated", id: "f", trace_id: "trace-f" });
    expect((await post(app, "/hooks/connections/conn1", { ...msg, headers: { ...msg.headers, ...funnel } })).status).toBe(204);
    // The owner funnelled the console itself (the public URL's host): not fenced.
    expect((await app.request("/api/system", { headers: { "tailscale-funnel-request": "?1", host: "box.tail1234.ts.net" } })).status).toBe(401);
    expect((await app.request("/api/system", { headers: { "tailscale-funnel-request": "?1", host: "BOX.tail1234.ts.net:443" } })).status).toBe(401); // default port
    ctx.settings.update({ publicUrl: "https://box.tail1234.ts.net:443" });
    expect((await app.request("/api/system", { headers: { "tailscale-funnel-request": "?1", host: "box.tail1234.ts.net" } })).status).toBe(401);
  });

  it("builds the webhook URL from the public URL", () => {
    expect(connectionHookUrl("https://inbox.example.com/", "conn1")).toBe("https://inbox.example.com/hooks/connections/conn1");
  });
});

describe("hook route dedupe memory", () => {
  it("is per connection and expires after its TTL (longer than the 2 h signature window)", async () => {
    let t = Date.parse("2026-10-16T12:00:00Z");
    const now = () => t;
    const fake = new FakeWhoop({ now });
    const emitted: IntegrationEvent[] = [];
    const host = whoopHost(fake, emitted);
    const routes = connectionHookRoutes({ enabled: () => true, host: () => host, log: createLogger("test"), now });
    expect(HOOK_DEDUPE_TTL_MS).toBeGreaterThan(2 * 3_600_000);

    expect((await post(routes, "/hooks/connections/conn1", fake.webhook({ type: "sleep.updated", id: "a", trace_id: "z" }))).status).toBe(204);
    t += 90 * 60_000; // a late retry, still inside the signature window
    expect((await post(routes, "/hooks/connections/conn1", fake.webhook({ type: "sleep.updated", id: "a", trace_id: "z" }))).status).toBe(204);
    expect(emitted).toHaveLength(1);
    t += HOOK_DEDUPE_TTL_MS;
    expect((await post(routes, "/hooks/connections/conn1", fake.webhook({ type: "sleep.updated", id: "a", trace_id: "z" }))).status).toBe(204);
    expect(emitted).toHaveLength(2);
  });
});
