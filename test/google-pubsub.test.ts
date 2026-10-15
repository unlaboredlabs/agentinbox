import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../server/context.ts";
import { HttpError } from "../server/util/errors.ts";
import { connectFakeAccount, FAKE_CLIENT, type FakeGoogle, PUBSUB_SCOPE, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const TOPIC = `projects/${FAKE_CLIENT.projectId}/topics/agentinbox-gmail`;
const SUB = `projects/${FAKE_CLIENT.projectId}/subscriptions/agentinbox-gmail-pull`;

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;

beforeEach(async () => {
  fake = await startFakeGoogle();
  const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

async function provisionError(): Promise<HttpError> {
  const err = await ctx.google.provisionPubsub().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe("Pub/Sub provisioning", () => {
  it("requires a project id and a connected account", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, projectId: "", appType: "internal" });
    expect((await provisionError()).message).toMatch(/project ID/);
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    expect((await provisionError()).message).toMatch(/Connect a Gmail account/);
  });

  it("creates topic, IAM grant and subscription, starts watches and switches to pubsub mode", async () => {
    const a = await connectFakeAccount(ctx, fake, "ops@example.com");
    const b = await connectFakeAccount(ctx, fake, "sales@example.com");
    const state = await ctx.google.provisionPubsub();
    expect(state).toEqual({ mode: "pubsub", topic: TOPIC, subscription: SUB, lastError: null, lastMessageAt: null });
    expect(ctx.settings.get().ingestMode).toBe("pubsub");
    expect(ctx.settings.getState("pubsub")?.principalAccountId).toBe(a.id);
    expect(fake.iamPolicy(TOPIC)?.bindings).toEqual([
      { role: "roles/pubsub.publisher", members: ["serviceAccount:gmail-api-push@system.gserviceaccount.com"] },
    ]);
    expect(fake.subscription(SUB)).toMatchObject({ topic: TOPIC, ackDeadlineSeconds: 60 });
    expect(fake.watch("ops@example.com")?.topic).toBe(TOPIC);
    expect(fake.watch("sales@example.com")?.topic).toBe(TOPIC);
    expect(ctx.accounts.get(b.id)!.watchExpiresAt).not.toBeNull();

    // Idempotent: a second run tolerates ALREADY_EXISTS and doesn't duplicate the binding.
    await expect(ctx.google.provisionPubsub()).resolves.toMatchObject({ topic: TOPIC, lastError: null });
    expect(fake.iamPolicy(TOPIC)?.bindings[0]!.members).toHaveLength(1);
  });

  it("explains the Domain Restricted Sharing org policy and stays in poll mode", async () => {
    await connectFakeAccount(ctx, fake, "it@corp.example");
    fake.orgPolicyBlocksIam(true);
    const err = await provisionError();
    expect(err.message).toMatch(/iam\.allowedPolicyMemberDomains/);
    expect(err.message).toMatch(/Domain Restricted Sharing/);
    expect(err.hint).toMatch(/poll mode/);
    expect(err.hint).toMatch(/exception/);
    expect(ctx.settings.get().ingestMode).toBe("poll");
    const state = ctx.google.pubsubState();
    expect(state.mode).toBe("poll");
    expect(state.lastError).toMatch(/allowedPolicyMemberDomains/);
  });

  it("explains a disabled Pub/Sub API with an enable link", async () => {
    await connectFakeAccount(ctx, fake, "a@example.com");
    fake.disableApi("pubsub", true);
    const err = await provisionError();
    expect(err.message).toMatch(/Cloud Pub\/Sub API isn't enabled/);
    expect(err.hint).toContain(`https://console.cloud.google.com/apis/library/pubsub.googleapis.com?project=${FAKE_CLIENT.projectId}`);
  });

  it("explains a disabled Gmail API (watch fails)", async () => {
    await connectFakeAccount(ctx, fake, "a@example.com");
    fake.disableApi("gmail", true);
    const err = await provisionError();
    expect(err.message).toMatch(/Gmail API isn't enabled/);
    expect(err.hint).toContain("gmail.googleapis.com");
    expect(ctx.settings.get().ingestMode).toBe("poll");
  });

  it("explains missing project permissions", async () => {
    fake.addAccount("intern@example.com", { projectAccess: false });
    await connectFakeAccount(ctx, fake, "intern@example.com");
    const err = await provisionError();
    expect(err.message).toMatch(/intern@example\.com doesn't have permission to manage Pub\/Sub/);
    expect(err.hint).toMatch(/Pub\/Sub Admin/);
  });

  it("asks to reconnect when the account didn't grant the pubsub scope", async () => {
    await connectFakeAccount(ctx, fake, "a@example.com", { scopes: ["https://www.googleapis.com/auth/gmail.modify", "openid"] });
    const err = await provisionError();
    expect(err.message).toMatch(/didn't grant agentinbox access to Pub\/Sub/);
    expect(err.hint).toMatch(/Reconnect/);
    expect(PUBSUB_SCOPE).toContain("pubsub");
  });

  it("tests the pipeline by publishing and pulling a message", async () => {
    expect((await ctx.google.testPubsub()).ok).toBe(false);
    await connectFakeAccount(ctx, fake, "a@example.com");
    await ctx.google.provisionPubsub();
    const result = await ctx.google.testPubsub();
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toMatch(/Pub\/Sub is working/);
    expect(ctx.google.pubsubState().lastMessageAt).not.toBeNull();
    expect(fake.subscription(SUB)).toMatchObject({ outstanding: 0, queued: 0 });
  });
});
