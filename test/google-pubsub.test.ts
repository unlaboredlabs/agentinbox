import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectAccountResponse } from "../shared/types.ts";
import { accountsApi } from "../server/api/accounts.ts";
import type { AppContext } from "../server/context.ts";
import { HttpError } from "../server/util/errors.ts";
import { connectFakeAccount, FAKE_CLIENT, type FakeGoogle, PUBSUB_SCOPE, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const TOPIC = `projects/${FAKE_CLIENT.projectId}/topics/agentinbox-gmail`;
const SUB = `projects/${FAKE_CLIENT.projectId}/subscriptions/agentinbox-gmail-pull`;

let fake: FakeGoogle;
let ctx: AppContext;
let rec: ReturnType<typeof recordingEvents>;
let dispose: () => Promise<void>;

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  fake = await startFakeGoogle();
  fake.pullWaitMs = 200;
  rec = recordingEvents();
  const t = testContext({ events: rec.factory }, { google: fake.google });
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
    const a = await connectFakeAccount(ctx, fake, "ops@example.com", { pubsub: true });
    const b = await connectFakeAccount(ctx, fake, "sales@example.com");
    const state = await ctx.google.provisionPubsub();
    expect(state).toEqual({
      mode: "pubsub",
      topic: TOPIC,
      subscription: SUB,
      lastError: null,
      lastMessageAt: null,
      principalAccountId: a.id,
      principalEmail: "ops@example.com",
      pendingPrincipalAccountId: null,
      pendingPrincipalEmail: null,
    });
    expect(ctx.settings.get().ingestMode).toBe("pubsub");
    expect(ctx.settings.getState("pubsub")?.principalAccountId).toBe(a.id);
    expect(fake.iamPolicy(TOPIC)?.bindings).toEqual([
      { role: "roles/pubsub.publisher", members: ["serviceAccount:gmail-api-push@system.gserviceaccount.com"] },
    ]);
    expect(fake.subscription(SUB)).toMatchObject({ topic: TOPIC, ackDeadlineSeconds: 60 });
    // getIamPolicy is a GET (a POST gets Google's HTML 404).
    expect(fake.requests).toContainEqual({ method: "GET", path: `/v1/${TOPIC}:getIamPolicy` });
    const post = await fetch(`${fake.url}/v1/${TOPIC}:getIamPolicy`, { method: "POST", body: "{}" });
    expect(post.status).toBe(404);
    expect(await post.text()).toContain("<!DOCTYPE html>");
    expect(fake.watch("ops@example.com")?.topic).toBe(TOPIC);
    expect(fake.watch("sales@example.com")?.topic).toBe(TOPIC);
    expect(ctx.accounts.get(b.id)!.watchExpiresAt).not.toBeNull();

    // Idempotent: a second run tolerates ALREADY_EXISTS and doesn't duplicate the binding.
    await expect(ctx.google.provisionPubsub()).resolves.toMatchObject({ topic: TOPIC, lastError: null });
    expect(fake.iamPolicy(TOPIC)?.bindings[0]!.members).toHaveLength(1);
  });

  it("explains the Domain Restricted Sharing org policy and stays in poll mode", async () => {
    await connectFakeAccount(ctx, fake, "it@corp.example", { pubsub: true });
    fake.orgPolicyBlocksIam(true);
    const err = await provisionError();
    expect(err.message).toMatch(/iam\.allowedPolicyMemberDomains/);
    expect(err.message).toMatch(/Domain Restricted Sharing/);
    expect(err.hint).toMatch(/poll mode/);
    expect(err.code).toBe("pubsub_org_policy");
    expect(err.hint).toContain("serviceAccount:gmail-api-push@system.gserviceaccount.com");
    expect(err.hint).toContain(`https://console.cloud.google.com/iam-admin/orgpolicies?project=${FAKE_CLIENT.projectId}`);
    expect(err.hint).toContain("roles/orgpolicy.policyAdmin");
    expect(err.hint).toMatch(/alternative is polling/);
    expect(ctx.settings.get().ingestMode).toBe("poll");
    const state = ctx.google.pubsubState();
    expect(state.mode).toBe("poll");
    expect(state.lastError).toMatch(/allowedPolicyMemberDomains/);
  });

  it("explains a disabled Pub/Sub API with an enable link", async () => {
    await connectFakeAccount(ctx, fake, "a@example.com", { pubsub: true });
    fake.disableApi("pubsub", true);
    const err = await provisionError();
    expect(err.message).toMatch(/Cloud Pub\/Sub API isn't enabled/);
    expect(err.hint).toContain(`https://console.cloud.google.com/flows/enableapi?apiid=pubsub.googleapis.com&project=${FAKE_CLIENT.projectId}`);
  });

  it("explains a disabled Gmail API (watch fails)", async () => {
    await connectFakeAccount(ctx, fake, "a@example.com", { pubsub: true });
    fake.disableApi("gmail", true);
    const err = await provisionError();
    expect(err.message).toMatch(/Gmail API isn't enabled/);
    expect(err.hint).toContain("gmail.googleapis.com");
    expect(ctx.settings.get().ingestMode).toBe("poll");
  });

  it("explains missing project permissions", async () => {
    fake.addAccount("intern@example.com", { projectAccess: false });
    await connectFakeAccount(ctx, fake, "intern@example.com", { pubsub: true });
    const err = await provisionError();
    expect(err.code).toBe("pubsub_permission_denied");
    expect(err.message).toMatch(/intern@example\.com lacks the Google Cloud IAM role/);
    expect(err.hint).toMatch(/roles\/pubsub\.admin\) or Owner/);
    expect(err.hint).toContain(`https://console.cloud.google.com/iam-admin/iam?project=${FAKE_CLIENT.projectId}`);
    expect(err.hint).toContain(
      `gcloud projects add-iam-policy-binding ${FAKE_CLIENT.projectId} --member=user:intern@example.com --role=roles/pubsub.admin`,
    );
    expect(err.hint).not.toMatch(/Editor or/);
  });

  it("asks for Pub/Sub access only when provisioning, via incremental consent", async () => {
    const acct = await connectFakeAccount(ctx, fake, "a@example.com");
    expect(ctx.db.get<{ scopes: string }>("SELECT scopes FROM accounts")!.scopes).not.toContain("pubsub");
    const err = await provisionError();
    expect(err.status).toBe(409);
    expect(err.code).toBe("pubsub_scope_required");
    expect(err.message).toMatch(/needs access to Pub\/Sub as a@example\.com/);

    // The console's "Grant Pub/Sub access" button: POST /api/accounts/connect {scopes:["pubsub"]}.
    fake.consentAs("a@example.com");
    const res = await accountsApi(ctx).request("/accounts/connect", { method: "POST", body: JSON.stringify({ scopes: ["pubsub"] }) });
    const { authUrl } = (await res.json()) as ConnectAccountResponse;
    const q = new URL(authUrl).searchParams;
    expect(q.get("scope")).toContain(PUBSUB_SCOPE);
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("login_hint")).toBe("a@example.com");
    const landed = (await fetch(authUrl, { redirect: "manual" })).headers.get("location")!;
    expect(await ctx.google.completeConnectFromUrl(landed)).toMatchObject({ id: acct.id, status: "active" });
    const scopes = JSON.parse(ctx.db.get<{ scopes: string }>("SELECT scopes FROM accounts")!.scopes) as string[];
    expect(scopes).toEqual(expect.arrayContaining([PUBSUB_SCOPE, "https://www.googleapis.com/auth/gmail.modify"]));
    await expect(ctx.google.provisionPubsub()).resolves.toMatchObject({ topic: TOPIC });
    // A later reconnect asks for Pub/Sub again (Google forgets scopes after a revocation).
    expect(new URL(ctx.google.startConnect({ reauthAccountId: acct.id }).authUrl).searchParams.get("scope")).toContain(PUBSUB_SCOPE);
  });

  it("keeps real-time delivery working after a test while the ingest loop is pulling", async () => {
    // Regression (seen on Node 22.13): testPubsub aborted its own in-flight long-poll pull; the next
    // Gmail notification was dispatched into that abandoned response and stranded until the ack deadline.
    fake.pullWaitMs = 1000;
    await connectFakeAccount(ctx, fake, "a@example.com", { pubsub: true });
    await ctx.google.provisionPubsub();
    ctx.ingest.start?.();
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 1; i <= 2; i++) {
      expect(await ctx.google.testPubsub()).toMatchObject({ ok: true });
      fake.deliver("a@example.com", { from: "x@y.test", subject: `Live ${i}`, text: "x" });
      await waitFor(() => rec.ofType("message.received").length === i, 3000);
    }
    expect(fake.abortedPulls).toBe(0);
  });

  it("tests the pipeline by publishing and pulling a message, leaving Gmail notifications for ingest", async () => {
    expect((await ctx.google.testPubsub()).ok).toBe(false);
    await connectFakeAccount(ctx, fake, "a@example.com", { pubsub: true });
    await ctx.google.provisionPubsub();
    // A real notification is waiting in the subscription when the test runs.
    fake.deliver("a@example.com", { from: "x@y.test", subject: "Real mail", text: "hi" });
    const result = await ctx.google.testPubsub();
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toMatch(/Pub\/Sub is working/);
    expect(ctx.google.pubsubState().lastMessageAt).not.toBeNull();
    // The Gmail notification was nacked, not acked: the ingest loop still gets it.
    expect(fake.requests.some((r) => r.path.endsWith(":modifyAckDeadline"))).toBe(true);
    ctx.ingest.start?.();
    await waitFor(() => rec.ofType("message.received").length === 1);
    expect(rec.events[0]!.message!.subject).toBe("Real mail");
  });
});
