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

    // Real time: no kicks, no poll interval (5 s); the notification drives the sync.
    const started = Date.now();
    s.fake.deliver(email, { from: "Rt <rt@else.test>", subject: "Realtime hello", text: "fast" });
    const ev = await s.waitForEvent((e) => e.message?.subject === "Realtime hello", { kick: false, timeout: 4000 });
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
    const ev = await s.waitForEvent((e) => e.message?.subject === "Polled mail", { kick: false, timeout: 9000 });
    expect(ev).toMatchObject({ type: "message.received", accountId: account!.id });
    expect((await s.admin.get<SystemInfo>("/api/system")).ingest).toMatchObject({ mode: "poll", running: true, lastError: null });
  }, 15_000);
});
