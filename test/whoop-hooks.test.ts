import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import type { IntegrationEvent } from "../server/broker/types.ts";
import type { AppContext } from "../server/context.ts";
import { type ConnectionHookHost, connectionHookUrl } from "../server/integrations/hooks.ts";
import { whoopPreset } from "../server/integrations/whoop/index.ts";
import { FAKE_WHOOP_CLIENT, FakeWhoop } from "./fake-whoop.ts";
import { testContext } from "./helpers.ts";

const silent = { info() {}, warn() {} };

describe("POST /hooks/connections/:id", () => {
  let ctx: AppContext;
  let dispose: () => Promise<void>;
  let fake: FakeWhoop;
  let emitted: IntegrationEvent[];
  let host: ConnectionHookHost;
  let flag: boolean;

  beforeEach(() => {
    ({ ctx, dispose } = testContext());
    fake = new FakeWhoop({ now: () => Date.now() });
    emitted = [];
    flag = true;
    const realGet = ctx.settings.get.bind(ctx.settings);
    vi.spyOn(ctx.settings, "get").mockImplementation(() => ({ ...realGet(), ...(flag ? { brokerUpstreams: true } : {}) }));
    const preset = whoopPreset();
    host = {
      webhookTarget: (id) =>
        id === "conn1"
          ? { preset, clientSecret: FAKE_WHOOP_CLIENT.clientSecret, deps: { connectionId: id, fetch: fake.fetch, log: silent, accessToken: async () => "unused" } }
          : null,
      emit: (events) => emitted.push(...events),
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose();
  });

  const post = (app: ReturnType<typeof createApp>, path: string, msg: { headers: Record<string, string>; rawBody: Buffer }) =>
    app.request(path, { method: "POST", headers: msg.headers, body: new Uint8Array(msg.rawBody) });

  it("verifies, emits and answers 204, outside admin auth and CSRF", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const msg = fake.webhook({ type: "recovery.updated", id: "sleep-uuid", trace_id: "trace-1" });
    const res = await post(app, "/hooks/connections/conn1", msg);
    expect(res.status).toBe(204);
    expect(emitted).toEqual([
      { type: "whoop.recovery_updated", connectionId: "conn1", dedupeKey: "whoop:trace-1", data: { sleepId: "sleep-uuid", traceId: "trace-1", whoopUserId: 10129 } },
    ]);
    // A retry with the same trace_id is acknowledged without a second event.
    expect((await post(app, "/hooks/connections/conn1", msg)).status).toBe(204);
    expect(emitted).toHaveLength(1);
  });

  it("401 on a bad signature or a stale timestamp; nothing emitted", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const forged = fake.webhook({ type: "sleep.updated", id: "a", trace_id: "t" }, { secret: "forged" });
    expect((await post(app, "/hooks/connections/conn1", forged)).status).toBe(401);
    const stale = fake.webhook({ type: "sleep.updated", id: "a", trace_id: "t" }, { timestamp: Date.now() - 60 * 60_000 });
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

  it("builds the webhook URL from the public URL", () => {
    expect(connectionHookUrl("https://inbox.example.com/", "conn1")).toBe("https://inbox.example.com/hooks/connections/conn1");
  });
});
