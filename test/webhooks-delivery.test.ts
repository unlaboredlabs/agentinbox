import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Delivery, MessageContent, MessageSummary, WebhookFilter, WebhookInput, WebhookPayload } from "../shared/types.ts";
import type { AppContext } from "../server/context.ts";
import type { NewEvent, StoredEvent } from "../server/events/types.ts";
import type { MailService } from "../server/mail/types.ts";
import type { PolicyService } from "../server/policy/types.ts";
import { HttpError } from "../server/util/errors.ts";
import { matchesFilter } from "../server/webhooks/filter.ts";
import { createWebhooksService, type WebhooksOptions } from "../server/webhooks/index.ts";
import { testContext } from "./helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Local receiver. `respond` decides the status for each request. */
async function receiver(respond: (n: number) => number = () => 200) {
  const requests: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      requests.push({ headers: req.headers, body });
      const status = respond(requests.length);
      if (status >= 300 && status < 400) res.setHeader("location", "https://elsewhere.example.com/");
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status >= 400 ? "x".repeat(600) : "ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, requests };
}

let mailCalls: string[] = [];
let mailFails = false;
const content: MessageContent = {
  body: "Hello **there**",
  truncated: false,
  attachments: [],
  signals: { hiddenContentRemoved: false, suspiciousInstructions: [], auth: null, external: true },
};

function setup(opts: WebhooksOptions = {}) {
  mailCalls = [];
  mailFails = false;
  const t = testContext({
    // agt_scoped sees only threads labelled Label_ok.
    policy: () =>
      ({
        canSeeEvent: (agentId: string, ev: { threadLabelIds: string[] }) => agentId !== "agt_scoped" || ev.threadLabelIds.includes("Label_ok"),
      }) as unknown as PolicyService,
    mail: () =>
      ({
        messageContent: async (accountId: string, messageId: string) => {
          mailCalls.push(`${accountId}/${messageId}`);
          if (mailFails) throw new Error("Gmail said no");
          return content;
        },
      }) as unknown as MailService,
    webhooks: (ctx) => createWebhooksService(ctx, { retryScheduleMs: [20, 20], tickMs: 10, ...opts }),
  });
  cleanups.push(t.dispose);
  const { ctx } = t;
  const ts = new Date().toISOString();
  ctx.db.run("INSERT INTO accounts (id, email, refresh_token_enc, created_at) VALUES ('acc_1', 'me@example.com', 'x', ?)", ts);
  for (const id of ["agt_all", "agt_scoped"]) {
    ctx.db.run("INSERT INTO agents (id, name, key_prefix, key_hash, created_at) VALUES (?, ?, 'aib_x', ?, ?)", id, id, `hash_${id}`, ts);
  }
  return ctx;
}

const input = (url: string, patch: Partial<WebhookInput> = {}): WebhookInput => ({
  agentId: "agt_all",
  name: "Hook",
  url,
  eventTypes: ["message.received"],
  filter: {},
  includeBody: false,
  enabled: true,
  ...patch,
});

const message = (id: string, patch: Partial<MessageSummary> = {}): MessageSummary => ({
  id,
  threadId: `t_${id}`,
  from: { name: "Alice", email: "alice@stripe.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [{ name: null, email: "billing@acme.io" }],
  subject: "Your invoice #42",
  snippet: "hi",
  date: new Date().toISOString(),
  labelIds: ["INBOX", "Label_ok"],
  hasAttachments: true,
  ...patch,
});

const received = (id: string, patch: Partial<MessageSummary> = {}): NewEvent => ({
  type: "message.received",
  accountId: "acc_1",
  message: message(id, patch),
  dedupeKey: `acc_1:${id}`,
});

async function until<T>(fn: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const deliveries = (ctx: AppContext, webhookId?: string) => ctx.webhooks.listDeliveries({ webhookId }).items;

/** Standard Webhooks verification written independently of the server, on WebCrypto. */
async function verifyStandardWebhook(secret: string, headers: IncomingHttpHeaders, body: string): Promise<boolean> {
  const id = String(headers["webhook-id"]);
  const timestamp = String(headers["webhook-timestamp"]);
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return String(headers["webhook-signature"])
    .split(" ")
    .some((s) => s.split(",")[0] === "v1" && s.split(",")[1] === expected);
}

describe("webhook filters", () => {
  const ev = (patch: Partial<StoredEvent> = {}): StoredEvent => ({
    id: "evt_1",
    seq: 1,
    type: "message.received",
    accountId: "acc_1",
    accountEmail: "me@example.com",
    message: message("m1"),
    createdAt: new Date().toISOString(),
    threadLabelIds: ["INBOX"],
    ...patch,
  });
  const cases: [WebhookFilter, boolean][] = [
    [{}, true],
    [{ accountIds: ["acc_1"] }, true],
    [{ accountIds: ["acc_2"] }, false],
    [{ labelIds: ["Label_ok", "Label_x"] }, true],
    [{ labelIds: ["Label_x"] }, false],
    [{ from: ["*@stripe.com"] }, true],
    [{ from: ["*@paypal.com"] }, false],
    [{ to: ["billing@*"] }, true],
    [{ to: ["*@nowhere.com"] }, false],
    [{ subject: "invoice\\s+#\\d+" }, true],
    [{ subject: "^receipt" }, false],
    [{ hasAttachments: true }, true],
    [{ hasAttachments: false }, false],
    [{ from: ["*@stripe.com"], subject: "INVOICE", labelIds: ["INBOX"] }, true],
    [{ from: ["*@stripe.com"], subject: "refund" }, false],
  ];
  it.each(cases)("%j → %s", (filter, expected) => expect(matchesFilter(filter, ev())).toBe(expected));

  it("account-level events only use accountIds", () => {
    const gap = ev({ type: "sync.gap", message: null });
    expect(matchesFilter({ from: ["*@x.com"], subject: "nope" }, gap)).toBe(true);
    expect(matchesFilter({ accountIds: ["acc_2"] }, gap)).toBe(false);
  });

  it("label events match on changed labels too", () => {
    const removed = ev({ type: "label.removed", labelIds: ["Label_gone"], message: message("m1", { labelIds: ["INBOX"] }) });
    expect(matchesFilter({ labelIds: ["Label_gone"] }, removed)).toBe(true);
  });

  it("message criteria never match events without a message", () => {
    expect(matchesFilter({ hasAttachments: false }, ev({ message: null }))).toBe(false);
  });
});

describe("webhook CRUD", () => {
  it("creates with a Standard Webhooks secret and validates input", async () => {
    const ctx = setup();
    const { webhook, secret } = await ctx.webhooks.create(input("https://93.184.216.34/hook", { filter: { from: ["*@stripe.com"], to: [] } }));
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(secret.slice(6), "base64")).toHaveLength(24);
    expect(webhook.secretPrefix).toBe(secret.slice(0, 12));
    expect(webhook.filter).toEqual({ from: ["*@stripe.com"] });
    expect(webhook.stats).toEqual({ succeeded24h: 0, failed24h: 0, lastDeliveryAt: null });
    const stored = ctx.db.get<{ secret_enc: string }>("SELECT secret_enc FROM webhooks")!.secret_enc;
    expect(stored).not.toContain(secret.slice(6));
    expect(ctx.crypto.decrypt(stored)).toBe(secret);

    const bad = async (patch: Partial<WebhookInput>) => {
      const err = await ctx.webhooks.create(input("https://93.184.216.34/", patch)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      return (err as HttpError).message;
    };
    expect(await bad({ eventTypes: [] })).toMatch(/at least one event type/);
    expect(await bad({ eventTypes: ["nope" as never] })).toBeTruthy();
    expect(await bad({ filter: { subject: "(" } })).toMatch(/regular expression/);
    expect(await bad({ filter: { subject: "a".repeat(201) } })).toMatch(/200/);
    expect(await bad({ filter: { fromm: ["x"] } as never })).toBeTruthy();
    expect(await bad({ agentId: "agt_missing" })).toMatch(/Agent not found/);
    expect(await bad({ url: "ftp://example.com" })).toMatch(/http/);
    expect(await bad({ url: "http://10.0.0.1/" })).toMatch(/private/);
    expect(await bad({ name: " " })).toMatch(/Name/);

    const rotated = ctx.webhooks.rotateSecret(webhook.id);
    expect(rotated.secret).not.toBe(secret);
    const updated = await ctx.webhooks.update(webhook.id, { name: "Renamed", enabled: false });
    expect(updated).toMatchObject({ name: "Renamed", enabled: false, url: webhook.url, filter: webhook.filter });
    await expect(ctx.webhooks.update(webhook.id, { url: "http://192.168.0.1/" })).rejects.toThrow(/private/);
    expect(ctx.webhooks.list("agt_all")).toHaveLength(1);
    expect(ctx.webhooks.list("agt_scoped")).toHaveLength(0);
    ctx.webhooks.remove(webhook.id);
    expect(ctx.webhooks.get(webhook.id)).toBeNull();
    expect(() => ctx.webhooks.remove(webhook.id)).toThrow(/not found/);
  });
});

describe("enqueue + delivery", () => {
  it("enqueues only for matching, visible, enabled webhooks and delivers signed payloads", async () => {
    const ctx = setup();
    const rx = await receiver();
    const all = await ctx.webhooks.create(input(rx.url, { filter: { from: ["*@stripe.com"] } }));
    const scoped = await ctx.webhooks.create(input(rx.url, { agentId: "agt_scoped" }));
    await ctx.webhooks.create(input(rx.url, { eventTypes: ["message.sent"] }));
    await ctx.webhooks.create(input(rx.url, { enabled: false }));
    const busDeliveries: Delivery[] = [];
    ctx.bus.on("delivery", (d) => busDeliveries.push(d));

    const visible = ctx.events.emit(received("m1"))!;
    const hidden = ctx.events.emit(received("m2", { labelIds: ["INBOX"] }))!; // scoped agent can't see it
    ctx.events.emit(received("m3", { from: { name: null, email: "bob@other.com" }, labelIds: ["INBOX"] })); // filtered for `all`, invisible for scoped
    expect(deliveries(ctx, all.webhook.id)).toHaveLength(2);
    expect(deliveries(ctx, scoped.webhook.id)).toHaveLength(1);
    expect(deliveries(ctx)).toHaveLength(3);
    expect(busDeliveries.filter((d) => d.status === "pending")).toHaveLength(3);

    ctx.webhooks.start!();
    await until(() => deliveries(ctx).every((d) => d.status === "succeeded"));
    expect(rx.requests).toHaveLength(3);

    for (const r of rx.requests) {
      expect(r.headers["content-type"]).toBe("application/json");
      expect(r.headers["user-agent"]).toBe("agentinbox/0.0.0-test");
      expect(r.headers["webhook-id"]).toMatch(/^dlv_/);
      const secret = r.headers["webhook-id"] && deliveries(ctx, all.webhook.id).some((d) => d.id === r.headers["webhook-id"]) ? all.secret : scoped.secret;
      expect(await verifyStandardWebhook(secret, r.headers, r.body)).toBe(true);
      expect(await verifyStandardWebhook(secret, r.headers, r.body + " ")).toBe(false);
    }
    const payloads = rx.requests.map((r) => JSON.parse(r.body) as WebhookPayload);
    expect(payloads.map((p) => p.data.id).sort()).toEqual([visible.id, visible.id, hidden.id].sort());
    const p = payloads.find((x) => x.data.id === visible.id)!;
    expect(p).toMatchObject({ type: "message.received", timestamp: visible.createdAt, data: { accountEmail: "me@example.com" } });
    expect(p.data).not.toHaveProperty("threadLabelIds");
    expect(p.data).not.toHaveProperty("content");

    const d = deliveries(ctx, all.webhook.id)[0]!;
    expect(d).toMatchObject({ status: "succeeded", attempts: 1, lastStatusCode: 200, lastResponse: "ok", nextAttemptAt: null, eventType: "message.received" });
    expect(busDeliveries.some((x) => x.id === d.id && x.status === "succeeded")).toBe(true);
    expect(ctx.webhooks.get(all.webhook.id)!.stats.succeeded24h).toBe(2);
    expect(ctx.webhooks.get(all.webhook.id)!.stats.lastDeliveryAt).not.toBeNull();
  });

  it("retries on failure with a stable webhook-id, then goes dead; replay re-sends", async () => {
    const ctx = setup();
    let failing = true;
    const rx = await receiver(() => (failing ? 500 : 204));
    const { webhook } = await ctx.webhooks.create(input(rx.url));
    ctx.webhooks.start!();
    ctx.events.emit(received("m1"));
    const dead = await until(() => deliveries(ctx).find((d) => d.status === "dead"));
    expect(rx.requests).toHaveLength(3); // 1 + two retries
    expect(new Set(rx.requests.map((r) => r.headers["webhook-id"]))).toEqual(new Set([dead.id]));
    expect(dead).toMatchObject({ attempts: 3, lastStatusCode: 500, nextAttemptAt: null });
    expect(dead.lastError).toMatch(/500/);
    expect(dead.lastResponse).toHaveLength(500);
    expect(ctx.webhooks.get(webhook.id)!.stats.failed24h).toBe(1);

    failing = false;
    const replayed = await ctx.webhooks.replay(dead.id);
    expect(replayed).toMatchObject({ id: dead.id, status: "succeeded", attempts: 4, lastStatusCode: 204, lastError: null });
    expect(rx.requests.at(-1)!.headers["webhook-id"]).toBe(dead.id);
    await expect(ctx.webhooks.replay("dlv_missing")).rejects.toThrow(/not found/);
  });

  it("treats redirects as failures", async () => {
    const ctx = setup();
    const rx = await receiver(() => 302);
    const { webhook } = await ctx.webhooks.create(input(rx.url));
    const d = await ctx.webhooks.test(webhook.id);
    expect(d).toMatchObject({ status: "failed", lastStatusCode: 302, nextAttemptAt: null });
    expect(d.lastError).toMatch(/redirect/i);
  });

  it("re-checks the SSRF guard at delivery time", async () => {
    const ctx = setup();
    const rx = await receiver();
    const { webhook } = await ctx.webhooks.create(input(rx.url));
    ctx.settings.update({ webhookAllowlist: [] });
    const d = await ctx.webhooks.test(webhook.id);
    expect(d.status).toBe("failed");
    expect(d.lastError).toMatch(/Blocked: 127\.0\.0\.1 is a private/);
    expect(rx.requests).toHaveLength(0);
  });

  it("pins the connection to the validated address (no second DNS lookup)", async () => {
    const rx = await receiver();
    let lookups = 0;
    const ctx = setup({
      lookup: async () => {
        lookups++;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    ctx.settings.update({ webhookAllowlist: ["hooks.test"] });
    const port = new URL(rx.url).port;
    const { webhook } = await ctx.webhooks.create(input(`http://hooks.test:${port}/hook`));
    const d = await ctx.webhooks.test(webhook.id);
    expect(d.status).toBe("succeeded");
    expect(lookups).toBe(2); // create + delivery; the HTTP client reused the validated address
    expect(rx.requests[0]!.headers.host).toBe(`hooks.test:${port}`);
  });

  it("includes the cleaned body via mail.messageContent, and degrades gracefully", async () => {
    const ctx = setup();
    const rx = await receiver();
    await ctx.webhooks.create(input(rx.url, { includeBody: true }));
    ctx.webhooks.start!();
    ctx.events.emit(received("m1"));
    await until(() => rx.requests.length === 1);
    const p = JSON.parse(rx.requests[0]!.body) as WebhookPayload;
    expect(p.data.content).toEqual(content);
    expect(mailCalls).toEqual(["acc_1/m1"]);

    mailFails = true;
    ctx.events.emit(received("m2"));
    await until(() => rx.requests.length === 2);
    const p2 = JSON.parse(rx.requests[1]!.body) as WebhookPayload & { data: { contentError?: string } };
    expect(p2.data.content).toBeUndefined();
    expect(p2.data.contentError).toMatch(/Gmail said no/);
    await until(() => deliveries(ctx).every((d) => d.status === "succeeded"));
  });

  it("marks deliveries dead when the agent lost access before delivery", async () => {
    const ctx = setup();
    const rx = await receiver();
    await ctx.webhooks.create(input(rx.url, { agentId: "agt_scoped" }));
    const ev = ctx.events.emit(received("m1"))!;
    ctx.db.run("UPDATE events SET label_ids = '[\"INBOX\"]' WHERE id = ?", ev.id); // simulate a scope change
    ctx.webhooks.start!();
    const d = await until(() => deliveries(ctx).find((x) => x.status === "dead"));
    expect(d.lastError).toMatch(/can no longer see/);
    expect(rx.requests).toHaveLength(0);
  });

  it("test deliveries use a synthetic event that never reaches feeds or the event list", async () => {
    const ctx = setup();
    const rx = await receiver();
    const { webhook, secret } = await ctx.webhooks.create(input(rx.url, { includeBody: true }));
    const events: unknown[] = [];
    ctx.bus.on("event", (e) => events.push(e));
    const d = await ctx.webhooks.test(webhook.id);
    expect(d).toMatchObject({ webhookId: webhook.id, status: "succeeded", attempts: 1, eventType: "message.received" });
    expect(d.eventId).toMatch(/^evt_/);
    const p = JSON.parse(rx.requests[0]!.body) as WebhookPayload;
    expect(p.data).toMatchObject({ id: d.eventId, detail: { test: true }, accountEmail: "test@agentinbox.invalid" });
    expect(p.data.seq).toBeLessThan(0);
    expect(p.data.content?.body).toMatch(/test delivery/);
    expect(mailCalls).toEqual([]);
    expect(await verifyStandardWebhook(secret, rx.requests[0]!.headers, rx.requests[0]!.body)).toBe(true);

    expect(events).toEqual([]);
    expect(ctx.events.feed("agt_all").events).toEqual([]);
    expect(ctx.events.list({}).items).toEqual([]);
    expect(ctx.events.get(d.eventId)).toBeNull();
    // A second test gets its own synthetic event.
    const d2 = await ctx.webhooks.test(webhook.id);
    expect(d2.eventId).not.toBe(d.eventId);
    // A real event still gets a positive seq afterwards.
    expect(ctx.events.emit(received("real"))!.seq).toBe(1);

    ctx.webhooks.remove(webhook.id);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE seq < 0")!.n).toBe(0);
  });

  it("pages deliveries and prunes finished ones", async () => {
    const ctx = setup();
    const rx = await receiver();
    const { webhook } = await ctx.webhooks.create(input(rx.url));
    for (let i = 0; i < 3; i++) ctx.events.emit(received(`m${i}`));
    const p1 = ctx.webhooks.listDeliveries({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = ctx.webhooks.listDeliveries({ limit: 2, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(ctx.webhooks.listDeliveries({ status: "succeeded" }).items).toHaveLength(0);

    await ctx.webhooks.test(webhook.id);
    ctx.webhooks.start!();
    await until(() => deliveries(ctx).every((d) => d.status === "succeeded"));
    expect(ctx.webhooks.prune(new Date(Date.now() + 1000).toISOString())).toBe(4);
    expect(deliveries(ctx)).toHaveLength(0);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE seq < 0")!.n).toBe(0);
  });

  it("leaves in-flight deliveries pending when stopped", async () => {
    const ctx = setup();
    const server = createServer(() => {
      /* never responds */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    });
    await ctx.webhooks.create(input(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`));
    ctx.webhooks.start!();
    ctx.events.emit(received("m1"));
    await new Promise((r) => setTimeout(r, 100));
    await ctx.webhooks.stop!();
    expect(deliveries(ctx)[0]).toMatchObject({ status: "pending", attempts: 0 });
  });
});
