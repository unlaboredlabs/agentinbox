// E2E 7: restart durability. The server is stopped with a webhook delivery in flight and the receiver
// down, restarted on the same data dir, and the delivery completes once the receiver is back. Mail that
// arrives while the server is down is ingested exactly once; resyncs never duplicate events.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebhooksService } from "../server/webhooks/index.ts";
import type { Account, Approval, Delivery, MailEvent, Page, SetupStatus, WebhookWithSecret } from "../shared/types.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import { startWebhookReceiver, verifyStandardWebhook, type WebhookReceiver } from "./e2e/webhook-receiver.ts";
import { sleep, waitFor } from "./e2e/wait.ts";

// The real webhooks service with a short retry schedule, so "retry after the receiver is back" takes
// milliseconds instead of the production 30 s first retry.
const fastRetries = { webhooks: (ctx: Parameters<typeof createWebhooksService>[0]) => createWebhooksService(ctx, { retryScheduleMs: [400, 400, 400, 400], tickMs: 100 }) };

let s: Stack;
let rx: WebhookReceiver;
let email: string;
let account: Account;
let apiKey: string;
let hook: WebhookWithSecret;

beforeAll(async () => {
  rx = await startWebhookReceiver();
  s = await startStack({ overrides: fastRetries });
  email = mailbox("restart");
  [account] = (await s.bootstrap({ accounts: [email], pubsub: true })) as [Account];
  if (!HAS_AGENTS) return; // webhooks need an agent (feat/policy-mcp)
  const created = await s.createAgent("durable", [grant(account.id, { capabilities: ["read"] })]);
  apiKey = created.apiKey;
  hook = await s.admin.post<WebhookWithSecret>("/api/webhooks", {
    agentId: created.agent.id,
    name: "durable",
    url: `${rx.url}/hooks/durable`,
    eventTypes: ["message.received"],
    includeBody: true,
  });
});
afterAll(async () => {
  await s.close();
  await rx.close();
});

const deliveries = async () => (await s.admin.get<Page<Delivery>>(`/api/deliveries?webhookId=${hook.webhook.id}`)).items;
const bySubject = (events: MailEvent[], subject: string) => events.filter((e) => e.message?.subject === subject);

describe("restart durability", () => {
  it.runIf(HAS_AGENTS)("completes a delivery that was in flight at shutdown once the server restarts and the receiver is back", async () => {
    rx.respondWith(() => "hang"); // the receiver accepts the request but never answers
    const msg = s.fake.deliver(email, { from: "Ops <ops@vendor.test>", subject: "Survive restart", text: "durable body" });
    const ev = await s.waitForEvent((e) => e.message?.id === msg.id);
    const inflight = await waitFor(() => rx.at("/hooks/durable")[0], { what: "in-flight delivery" });

    await s.stopServer();
    await rx.stop(); // receiver down
    rx.respondWith(null);

    await s.restart(fastRetries);
    // Attempted against the dead receiver after restart: failed with a retry scheduled (not dead).
    const failed = await waitFor(async () => (await deliveries()).find((d) => d.eventId === ev.id && d.status === "failed"), { what: "failed retry after restart" });
    expect(failed.lastError).toMatch(/refused/i);
    expect(failed.nextAttemptAt).not.toBeNull();

    await rx.start(); // receiver back
    const done = await waitFor(async () => (await deliveries()).find((d) => d.eventId === ev.id && d.status === "succeeded"), { what: "delivery after the receiver is back", timeout: 5000 });
    // The attempt aborted by the shutdown doesn't count; the one against the dead receiver does.
    expect(done.attempts).toBe(2);

    const received = rx.at("/hooks/durable");
    expect(received).toHaveLength(2);
    const final = received[1]!;
    expect(final.headers["webhook-id"]).toBe(inflight.headers["webhook-id"]);
    expect(verifyStandardWebhook(hook.secret, final)).toEqual({ ok: true }); // secret survived (encrypted at rest)
    expect(final.json!.data.id).toBe(ev.id);
    expect(final.json!.data.content?.body).toBe("durable body");
    expect((await deliveries()).filter((d) => d.eventId === ev.id)).toHaveLength(1);
  });

  it("keeps the admin session across a restart", async () => {
    await s.restart(fastRetries);
    expect(await s.admin.get<SetupStatus>("/api/setup/status")).toEqual({ claimed: true, authenticated: true });
  });

  it.runIf(HAS_AGENTS)("keeps agent keys and event cursors across a restart", async () => {
    const mcp = await s.agent(apiKey);
    const before = await mcp.ok("list_events", { limit: 100 });
    const lastSeq = Number(/ack_events with seq=(\d+)/.exec(before)![1]);
    await mcp.ok("ack_events", { seq: lastSeq });
    await mcp.close();

    await s.restart(fastRetries);
    expect(await s.admin.get<SetupStatus>("/api/setup/status")).toEqual({ claimed: true, authenticated: true });
    const again = await s.agent(apiKey);
    try {
      expect(await again.ok("list_events")).toMatch(new RegExp(`^No new events\\. Cursor: ${lastSeq} \\(acknowledged up to ${lastSeq}\\)`));
    } finally {
      await again.close();
    }
  });

  it("ingests mail that arrived while the server was down exactly once, and resyncs don't duplicate events", async () => {
    await s.stopServer();
    // Gmail keeps publishing notifications to the subscription while agentinbox is down.
    const down1 = s.fake.deliver(email, { from: "a@vendor.test", subject: "While down 1", text: "1" });
    const down2 = s.fake.deliver(email, { from: "b@vendor.test", subject: "While down 2", text: "2" });
    await s.restart(fastRetries);

    await s.waitForEvent((e) => e.message?.id === down1.id);
    await s.waitForEvent((e) => e.message?.id === down2.id);
    const live = s.fake.deliver(email, { from: "c@vendor.test", subject: "After restart", text: "3" });
    await s.waitForEvent((e) => e.message?.id === live.id);
    await sleep(300); // let any late duplicate notification be processed

    // A manual resync and an expired history cursor both re-scan recent mail; dedupe keeps one event each.
    await s.admin.post(`/api/accounts/${account.id}/resync`);
    s.fake.expireHistory(email);
    const trigger = s.fake.deliver(email, { from: "d@vendor.test", subject: "After expiry", text: "4" });
    await s.waitForEvent((e) => e.message?.id === trigger.id);

    const events = await s.events({ accountId: account.id });
    for (const subject of [...(HAS_AGENTS ? ["Survive restart"] : []), "While down 1", "While down 2", "After restart", "After expiry"]) {
      expect(bySubject(events, subject).filter((e) => e.type === "message.received"), subject).toHaveLength(1);
    }
    const gaps = events.filter((e) => e.type === "sync.gap");
    expect(gaps.map((e) => e.detail?.reason).sort()).toEqual(["history_expired", "manual"]);

    // And the webhook got each message once.
    if (!HAS_AGENTS) return;
    await waitFor(async () => (await deliveries()).filter((d) => d.status === "succeeded").length >= 5, { what: "5 succeeded deliveries" });
    const subjects = rx.at("/hooks/durable").map((h) => h.json!.data.message?.subject);
    for (const subject of ["While down 1", "While down 2", "After restart", "After expiry"]) {
      expect(subjects.filter((x) => x === subject), subject).toHaveLength(1);
    }
  });

  it.runIf(HAS_AGENTS)("keeps a pending approval across a restart and sends it when approved afterwards", async () => {
    const sender = await s.createAgent("restart-sender", [grant(account.id, { capabilities: ["read", "send"], sendMode: "approval" })]);
    const msg = s.fake.deliver(email, { from: "Alice <alice@client.test>", subject: "Pending over restart", text: "?" });
    const mcp = await s.agent(sender.apiKey);
    const r = await mcp.json<{ approvalId: string }>("reply", { message_id: msg.id, body: "Answer after restart" });
    await mcp.close();

    await s.restart(fastRetries);
    const pending = await s.admin.get<Approval[]>("/api/approvals?status=pending");
    expect(pending.map((a) => a.id)).toContain(r.approvalId);
    const sent = await s.admin.post<Approval>(`/api/approvals/${r.approvalId}/approve`);
    expect(sent.status).toBe("sent");
    expect(s.fake.sent(email).some((m) => m.id === sent.sentMessageId && m.threadId === msg.threadId)).toBe(true);
  });
});
