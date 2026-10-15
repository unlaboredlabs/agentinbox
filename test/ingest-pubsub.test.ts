import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../server/context.ts";
import { connectFakeAccount, FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const ME = "me@example.com";
const SUB = `projects/${FAKE_CLIENT.projectId}/subscriptions/agentinbox-gmail-pull`;

let fake: FakeGoogle;
let ctx: AppContext;
let rec: ReturnType<typeof recordingEvents>;
let dispose: () => Promise<void>;
let accountId: string;

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  fake = await startFakeGoogle();
  fake.pullWaitMs = 300;
  rec = recordingEvents();
  const t = testContext({ events: rec.factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  accountId = (await connectFakeAccount(ctx, fake, ME)).id;
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

describe("pubsub ingest", () => {
  it("pulls Gmail notifications, syncs, acks and stops promptly", async () => {
    await ctx.google.provisionPubsub();
    ctx.ingest.start?.();
    await waitFor(() => ctx.ingest.status().lastPullAt !== null);
    expect(ctx.ingest.status()).toMatchObject({ mode: "pubsub", running: true, lastError: null });

    const label = fake.addLabel(ME, "Support");
    const m = fake.deliver(ME, { from: "Cust <c@cust.test>", subject: "Help", text: "pls", labelIds: ["INBOX", label] });
    await waitFor(() => rec.ofType("message.received").length === 1);
    expect(rec.events[0]).toMatchObject({ dedupeKey: `${accountId}:${m.id}:message.received` });
    expect(rec.events[0]!.threadLabelIds).toContain(label);
    fake.setLabels(ME, m.id, [], ["UNREAD", "INBOX"]);
    await waitFor(() => rec.ofType("label.removed").length === 1);
    expect(rec.ofType("label.removed")[0]!.labelIds).toEqual(["INBOX"]);
    await waitFor(() => fake.subscription(SUB)!.outstanding === 0 && fake.subscription(SUB)!.queued === 0);
    expect(ctx.google.pubsubState().lastMessageAt).not.toBeNull();

    const t = Date.now();
    await ctx.ingest.stop?.();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(ctx.ingest.status().running).toBe(false);
  });

  it("starts a watch for accounts connected later, and on resume", async () => {
    await ctx.google.provisionPubsub();
    ctx.ingest.start?.();
    const other = await connectFakeAccount(ctx, fake, "second@example.com");
    expect(fake.watch("second@example.com")).not.toBeNull();
    expect(ctx.accounts.get(other.id)!.watchExpiresAt).not.toBeNull();
    await ctx.ingest.pause(other.id);
    expect(fake.watch("second@example.com")).toBeNull();
    expect(ctx.accounts.get(other.id)!.watchExpiresAt).toBeNull();
    await ctx.ingest.resume(other.id);
    expect(fake.watch("second@example.com")).not.toBeNull();
  });

  it("stops watches when switching back to poll mode", async () => {
    await ctx.google.provisionPubsub();
    ctx.ingest.start?.();
    expect(fake.watch(ME)).not.toBeNull();
    ctx.settings.update({ ingestMode: "poll" });
    await waitFor(() => fake.watch(ME) === null);
    expect(ctx.accounts.get(accountId)!.watchExpiresAt).toBeNull();
    await waitFor(() => ctx.ingest.status().mode === "poll" && ctx.ingest.status().running);
    fake.deliver(ME, { from: "x@y.test", subject: "Polled", text: "x" });
    ctx.ingest.kick(accountId);
    await waitFor(() => rec.events.length === 1);
  });

  it("keeps ingesting by polling when the pull fails", async () => {
    await ctx.google.provisionPubsub();
    fake.failNext({ path: ":pull", status: 403, message: "User not authorized to perform this action.", times: 100 });
    ctx.ingest.start?.();
    await waitFor(() => ctx.ingest.status().lastError !== null);
    expect(ctx.ingest.status().lastError).toMatch(/Pub\/Sub pull failed: .*permission/);
    expect(ctx.google.pubsubState().lastError).toMatch(/Pub\/Sub pull failed/);
    fake.deliver(ME, { from: "x@y.test", subject: "Still flowing", text: "x" });
    ctx.ingest.kick();
    await waitFor(() => rec.events.length === 1);
  });

  it("polls instead when pubsub mode is selected but not provisioned", async () => {
    ctx.settings.update({ ingestMode: "pubsub" });
    ctx.ingest.start?.();
    await waitFor(() => ctx.ingest.status().lastPullAt !== null);
    expect(ctx.ingest.status()).toMatchObject({ mode: "pubsub", running: true });
    expect(ctx.ingest.status().lastError).toMatch(/polling instead/);
    // Provisioning later switches the running loop to pulling.
    await ctx.google.provisionPubsub();
    await waitFor(() => ctx.ingest.status().lastError === null);
    fake.deliver(ME, { from: "x@y.test", subject: "Pushed", text: "x" });
    await waitFor(() => rec.events.length === 1);
  });

  it("onAccountConnected keeps the cursor of a reconnected account and catches up", async () => {
    fake.deliver(ME, { from: "x@y.test", subject: "Missed while broken", text: "x" });
    ctx.accounts.setStatus(accountId, "needs_reauth", "revoked");
    await connectFakeAccount(ctx, fake, ME, { reauthAccountId: accountId });
    await waitFor(() => rec.events.length === 1);
    expect(rec.events[0]!.message!.subject).toBe("Missed while broken");
  });
});
