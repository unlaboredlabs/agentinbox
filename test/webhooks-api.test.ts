import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { Delivery, Page, Webhook, WebhookWithSecret } from "../shared/types.ts";
import type { AppEnv } from "../server/api/util.ts";
import { webhooksApi } from "../server/api/webhooks.ts";
import type { PolicyService } from "../server/policy/types.ts";
import { HttpError } from "../server/util/errors.ts";
import { testContext } from "./helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const t = testContext({ policy: () => ({ canSeeEvent: () => true }) as unknown as PolicyService });
  cleanups.push(t.dispose);
  const { ctx } = t;
  ctx.db.run("INSERT INTO agents (id, name, key_prefix, key_hash, created_at) VALUES ('agt_1', 'Bot', 'aib_x', 'h', ?)", new Date().toISOString());
  const app = new Hono<AppEnv>().route("/api", webhooksApi(ctx));
  app.onError((err, c) => (err instanceof HttpError ? c.json(err.toJSON(), err.status as 400) : c.json({ error: { code: "internal", message: err.message } }, 500)));
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200).end("ok"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook?token=sekret`;
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as T };
  };
  return { ctx, url, call };
}

describe("webhooks API", () => {
  it("supports the full lifecycle and audits admin mutations", async () => {
    const { ctx, url, call } = await setup();
    const created = await call<WebhookWithSecret>("POST", "/webhooks", { agentId: "agt_1", name: "Hook", url, eventTypes: ["message.received"] });
    expect(created.status).toBe(200);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body.webhook).toMatchObject({ includeBody: false, enabled: true, filter: {} });
    const id = created.body.webhook.id;

    expect((await call<Webhook[]>("GET", "/webhooks?agentId=agt_1")).body).toHaveLength(1);
    expect((await call<Webhook[]>("GET", "/webhooks?agentId=agt_2")).body).toHaveLength(0);

    const patched = await call<Webhook>("PATCH", `/webhooks/${id}`, { filter: { subject: "invoice" } });
    expect(patched.body.filter).toEqual({ subject: "invoice" });
    expect((await call("PATCH", `/webhooks/${id}`, { eventTypes: [] })).status).toBe(400);
    expect((await call("PATCH", "/webhooks/whk_missing", { name: "x" })).status).toBe(404);

    const rotated = await call<WebhookWithSecret>("POST", `/webhooks/${id}/rotate-secret`);
    expect(rotated.body.secret).not.toBe(created.body.secret);

    const tested = await call<Delivery>("POST", `/webhooks/${id}/test`);
    expect(tested.body).toMatchObject({ status: "succeeded", lastStatusCode: 200 });

    const page = await call<Page<Delivery>>("GET", `/deliveries?webhookId=${id}&status=succeeded`);
    expect(page.body.items.map((d) => d.id)).toEqual([tested.body.id]);
    expect((await call("GET", "/deliveries?status=weird")).status).toBe(400);
    expect((await call("GET", "/deliveries?cursor=x")).status).toBe(400);

    const replayed = await call<Delivery>("POST", `/deliveries/${tested.body.id}/replay`);
    expect(replayed.body).toMatchObject({ status: "succeeded", attempts: 2 });
    expect((await call("POST", "/deliveries/dlv_missing/replay")).status).toBe(404);

    expect((await call("DELETE", `/webhooks/${id}`)).status).toBe(204);
    expect((await call("DELETE", `/webhooks/${id}`)).status).toBe(404);

    const actions = ctx.audit.list().items.map((e) => e.action);
    expect(actions).toEqual(["webhook.delete", "delivery.replay", "webhook.test", "webhook.rotate_secret", "webhook.update", "webhook.create"]);
    const entry = ctx.audit.list({ action: "webhook.create" }).items[0]!;
    expect(entry).toMatchObject({ actorType: "admin", target: id, outcome: "ok" });
    expect(JSON.stringify(entry.detail)).not.toContain("sekret");
  });

  it("rejects invalid bodies and SSRF targets with 400", async () => {
    const { call } = await setup();
    const bad = await call<{ error: { message: string; hint?: string } }>("POST", "/webhooks", {
      agentId: "agt_1",
      name: "Hook",
      url: "http://192.168.1.20/",
      eventTypes: ["message.received"],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/private/);
    expect(bad.body.error.hint).toMatch(/allowlist/);
    expect((await call("POST", "/webhooks", { name: "x" })).status).toBe(400);
  });
});
