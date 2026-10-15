// E2E 3: Pub/Sub provisioning through the console API, the real-time ingest path it enables, the
// Workspace org-policy failure with its remediation hint, and the poll fallback.

import { afterEach, describe, expect, it } from "vitest";
import type { PubsubState, PubsubTestResult, Settings, SetupState, SystemInfo } from "../shared/types.ts";
import { mailbox, type Stack, startStack } from "./e2e/harness.ts";
import { sleep, waitFor } from "./e2e/wait.ts";

const TOPIC = "projects/fake-project/topics/agentinbox-gmail";
const SUBSCRIPTION = "projects/fake-project/subscriptions/agentinbox-gmail-pull";

/** Hourly polling, so only Pub/Sub can deliver within a test's timeouts. */
const NO_POLLING = { pollIntervalSeconds: 3600 };
/** Generous for slow CI runners; real time on a healthy runner is ~1 s. */
const REALTIME_TIMEOUT = 15_000;

let s: Stack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("pub/sub provisioning", () => {
  it("provisions topic, IAM and subscription, switches ingest to pubsub and delivers mail in real time", async () => {
    s = await startStack();
    const email = mailbox("pubsub");
    // Hourly polling: anything that arrives within the test's timeouts came through Pub/Sub.
    const [account] = await s.bootstrap({ accounts: [email], settings: NO_POLLING });

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

    // Real time: no kicks, polling is hourly and the Pub/Sub safety-net sync runs every 5 minutes, so
    // an event within the (generous, slow-CI-proof) timeout can only come from the notification.
    s.fake.deliver(email, { from: "Rt <rt@else.test>", subject: "Realtime hello", text: "fast" });
    const ev = await s.waitForEvent((e) => e.message?.subject === "Realtime hello", { kick: false, timeout: REALTIME_TIMEOUT });
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
    await s.admin.patch("/api/settings", NO_POLLING);
    s.fake.orgPolicyBlocksIam(false);
    const fixed = await s.provisionPubsub();
    expect(fixed).toMatchObject({ mode: "pubsub", topic: TOPIC, subscription: SUBSCRIPTION, lastError: null });
    expect((await s.admin.get<SetupState>("/api/setup/state")).pubsub.lastError).toBeNull();
    s.fake.deliver(email, { from: "poll@else.test", subject: "Realtime at last", text: "x" });
    await s.waitForEvent((e) => e.message?.subject === "Realtime at last", { kick: false, timeout: REALTIME_TIMEOUT });
  }, 45_000);

  it("watches accounts connected after provisioning and stops the watch when an account is removed", async () => {
    s = await startStack();
    const first = mailbox("ps-first");
    const second = mailbox("ps-second");
    await s.bootstrap({ accounts: [first], pubsub: true, settings: NO_POLLING });
    const acc2 = await s.connectAccount(second);
    expect(s.fake.watch(second)?.topic).toBe(TOPIC);

    s.fake.deliver(second, { from: "x@else.test", subject: "Second realtime", text: "x" });
    await s.waitForEvent((e) => e.message?.subject === "Second realtime", { kick: false, timeout: REALTIME_TIMEOUT });

    await s.admin.del(`/api/accounts/${acc2.id}`);
    expect(s.fake.watch(second)).toBeNull();
  });

  // Regression (fixed on main): the pull loop used to stay in its exponential backoff (2, 4, 8 … 60 s)
  // after the principal account was reconnected.
  it("resumes real-time ingest promptly after the Pub/Sub principal account is reconnected", async () => {
    s = await startStack();
    const email = mailbox("ps-principal");
    const [account] = await s.bootstrap({ accounts: [email], pubsub: true, settings: NO_POLLING });
    s.fake.failRefresh(email);
    s.kick(account!.id);
    await waitFor(async () => (await s!.admin.get<{ id: string; status: string }[]>("/api/accounts"))[0]!.status === "needs_reauth", { what: "needs_reauth" });
    // The pull loop fails meanwhile (no usable principal). After ~7.5 s its backoff has reached 8 s, so
    // without prompt recovery the next pull is ≥ 6 s away when we reconnect.
    await sleep(7500);

    await s.connectAccount(email, { reauthAccountId: account!.id });
    s.fake.deliver(email, { from: "x@else.test", subject: "Realtime after reauth", text: "x" });
    // Bound, deliberately: a recovered loop delivers in about one pull (~1 s; generous 5 s for slow CI),
    // a loop still in backoff takes ≥ 6 s. Polling is hourly, so nothing else can deliver it.
    await s.waitForEvent((e) => e.message?.subject === "Realtime after reauth", { kick: false, timeout: 5000 });
  }, 40_000);
});
