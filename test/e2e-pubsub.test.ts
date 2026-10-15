// E2E 3: Pub/Sub provisioning through the console API, the real-time ingest path it enables, the
// Workspace org-policy failure with its remediation hint, and the poll fallback.

import { afterEach, describe, expect, it } from "vitest";
import type { PubsubState, PubsubTestResult, Settings, SetupState, SystemInfo } from "../shared/types.ts";
import { mailbox, type Stack, startStack } from "./e2e/harness.ts";
import { waitFor } from "./e2e/wait.ts";

const TOPIC = "projects/fake-project/topics/agentinbox-gmail";
const SUBSCRIPTION = "projects/fake-project/subscriptions/agentinbox-gmail-pull";

let s: Stack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("pub/sub provisioning", () => {
  it("provisions topic, IAM and subscription, switches ingest to pubsub and delivers mail in real time", async () => {
    s = await startStack();
    const email = mailbox("pubsub");
    const [account] = await s.bootstrap({ accounts: [email] });

    // Accounts connect with Gmail scopes only; Pub/Sub access is requested incrementally, on demand.
    const needScope = await s.admin.failure(s.admin.post("/api/google/pubsub/provision"));
    expect(needScope.status).toBe(409);
    expect(needScope.code).toBe("pubsub_scope_required");
    expect(needScope.body!.error.message).toContain(email);
    const consent = await s.admin.post<{ authUrl: string }>("/api/accounts/connect", { reauthAccountId: account!.id, scopes: ["pubsub"] });
    expect(new URL(consent.authUrl).searchParams.get("scope")).toContain("https://www.googleapis.com/auth/pubsub");
    await s.connectAccount(email, { reauthAccountId: account!.id, scopes: ["pubsub"] });

    const state = await s.admin.post<PubsubState>("/api/google/pubsub/provision");
    expect(state).toMatchObject({ mode: "pubsub", topic: TOPIC, subscription: SUBSCRIPTION, lastError: null });

    // What Google now has.
    expect(s.fake.topics()).toContain(TOPIC);
    expect(s.fake.iamPolicy(TOPIC)?.bindings).toContainEqual({
      role: "roles/pubsub.publisher",
      members: ["serviceAccount:gmail-api-push@system.gserviceaccount.com"],
    });
    expect(s.fake.subscription(SUBSCRIPTION)?.topic).toBe(TOPIC);
    expect(s.fake.watch(email)?.topic).toBe(TOPIC);

    expect((await s.admin.get<Settings>("/api/settings")).ingestMode).toBe("pubsub");
    expect((await s.admin.get<SetupState>("/api/setup/state")).pubsub).toMatchObject({ mode: "pubsub", topic: TOPIC, subscription: SUBSCRIPTION });
    await waitFor(async () => {
      const sys = await s!.admin.get<SystemInfo>("/api/system");
      return sys.ingest.mode === "pubsub" && sys.ingest.running;
    }, { what: "ingest running in pubsub mode" });
    expect((await s.admin.get<{ watchExpiresAt: string | null }[]>("/api/accounts"))[0]!.watchExpiresAt).not.toBeNull();

    // Provisioning again is idempotent.
    expect(await s.admin.post<PubsubState>("/api/google/pubsub/provision")).toMatchObject({ mode: "pubsub", topic: TOPIC });

    const test = await s.admin.post<PubsubTestResult>("/api/google/pubsub/test");
    expect(test.ok).toBe(true);
    expect(test.message).toMatch(/Pub\/Sub is working/);

    // Real time: no kicks; in healthy Pub/Sub mode the only polling is the 5-minute safety net, so
    // delivery within 15 s proves the notification drove the sync (generous for slow CI runners).
    const started = Date.now();
    s.fake.deliver(email, { from: "Rt <rt@else.test>", subject: "Realtime hello", text: "fast" });
    const ev = await s.waitForEvent((e) => e.message?.subject === "Realtime hello", { kick: false, timeout: 15_000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(ev).toMatchObject({ type: "message.received", accountId: account!.id });
    await waitFor(async () => (await s!.admin.get<SetupState>("/api/setup/state")).pubsub.lastMessageAt, { what: "pubsub.lastMessageAt" });

    // Switching back to poll stops the Gmail watch, and mail keeps flowing.
    await s.admin.patch("/api/settings", { ingestMode: "poll" });
    await waitFor(() => s!.fake.watch(email) === null, { what: "watch stopped" });
    s.fake.deliver(email, { from: "rt@else.test", subject: "Polled after switch", text: "slow" });
    await s.waitForEvent((e) => e.message?.subject === "Polled after switch");
  });

  it("explains the Workspace org-policy failure with a hint, stays on poll, and poll mode still receives mail", async () => {
    s = await startStack();
    s.fake.orgPolicyBlocksIam(true);
    const email = mailbox("orgpolicy");
    const [account] = await s.bootstrap({ accounts: [email] });
    await s.connectAccount(email, { reauthAccountId: account!.id, scopes: ["pubsub"] });

    const fail = await s.admin.failure(s.admin.post("/api/google/pubsub/provision"));
    expect(fail.status).toBe(400);
    expect(fail.code).toBe("pubsub_provision_failed");
    expect(fail.body!.error.message).toMatch(/organization policy/i);
    expect(fail.body!.error.message).toContain("iam.allowedPolicyMemberDomains");
    expect(fail.body!.error.hint).toMatch(/poll mode/i);

    const state = await s.admin.get<SetupState>("/api/setup/state");
    expect(state.pubsub.mode).toBe("poll");
    expect(state.pubsub.subscription).toBeNull();
    expect(state.pubsub.lastError).toMatch(/organization policy/i);
    expect(s.fake.watch(email)).toBeNull();

    const test = await s.admin.post<PubsubTestResult>("/api/google/pubsub/test");
    expect(test.ok).toBe(false);
    expect(test.message).toMatch(/isn't provisioned/);

    // The user picks poll (the wizard's fallback). The real poll loop (5 s) picks up new mail: no kicks.
    await s.admin.patch("/api/settings", { ingestMode: "poll", pollIntervalSeconds: 5 });
    s.fake.deliver(email, { from: "Poll <poll@else.test>", subject: "Polled mail", text: "still works" });
    const ev = await s.waitForEvent((e) => e.message?.subject === "Polled mail", { kick: false, timeout: 15_000 });
    expect(ev).toMatchObject({ type: "message.received", accountId: account!.id });
    expect((await s.admin.get<SystemInfo>("/api/system")).ingest).toMatchObject({ mode: "poll", running: true, lastError: null });

    // The org admin grants an exception: retrying provisioning reuses the existing topic and succeeds.
    s.fake.orgPolicyBlocksIam(false);
    const fixed = await s.provisionPubsub();
    expect(fixed).toMatchObject({ mode: "pubsub", topic: TOPIC, subscription: SUBSCRIPTION, lastError: null });
    expect((await s.admin.get<SetupState>("/api/setup/state")).pubsub.lastError).toBeNull();
    s.fake.deliver(email, { from: "poll@else.test", subject: "Realtime at last", text: "x" });
    await s.waitForEvent((e) => e.message?.subject === "Realtime at last", { kick: false, timeout: 15_000 });
  }, 20_000);

  it("watches accounts connected after provisioning and stops the watch when an account is removed", async () => {
    s = await startStack();
    const first = mailbox("ps-first");
    const second = mailbox("ps-second");
    await s.bootstrap({ accounts: [first], pubsub: true });
    const acc2 = await s.connectAccount(second);
    expect(s.fake.watch(second)?.topic).toBe(TOPIC);

    s.fake.deliver(second, { from: "x@else.test", subject: "Second realtime", text: "x" });
    await s.waitForEvent((e) => e.message?.subject === "Second realtime", { kick: false, timeout: 15_000 });

    await s.admin.del(`/api/accounts/${acc2.id}`);
    expect(s.fake.watch(second)).toBeNull();
  });

  // Regression (fixed on main): the pull loop used to stay in its exponential backoff after the principal was reconnected.
  it("resumes real-time ingest promptly after the Pub/Sub principal account is reconnected", async () => {
    s = await startStack();
    const email = mailbox("ps-principal");
    const [account] = await s.bootstrap({ accounts: [email], pubsub: true });
    s.fake.failRefresh(email);
    s.kick(account!.id);
    await waitFor(async () => (await s!.admin.get<{ id: string; status: string }[]>("/api/accounts"))[0]!.status === "needs_reauth", { what: "needs_reauth" });
    await new Promise((r) => setTimeout(r, 3500)); // the pull loop fails meanwhile (no usable principal) and backs off

    await s.connectAccount(email, { reauthAccountId: account!.id });
    s.fake.deliver(email, { from: "x@else.test", subject: "Realtime after reauth", text: "x" });
    // Real time means about a second (one pull), as before the outage; without the fix this takes ≥ 2.5 s.
    await s.waitForEvent((e) => e.message?.subject === "Realtime after reauth", { kick: false, timeout: 4500 });
  }, 15_000);
});
