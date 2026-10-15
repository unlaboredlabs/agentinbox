import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayDead } from "../server/listen/admin.ts";
import { Dispatcher, type Job } from "../server/listen/dispatcher.ts";
import { matchesLocal } from "../server/listen/event.ts";
import { runListener } from "../server/listen/listen.ts";
import { resolveListen } from "../server/listen/options.ts";
import { deadPath } from "../server/listen/paths.ts";
import { loadProfile, saveProfile } from "../server/listen/profile.ts";
import { readDead } from "../server/listen/state.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

describe("dispatcher", () => {
  it("acknowledges only the contiguous prefix of finished events", async () => {
    const release = new Map<number, (errors: string[]) => void>();
    const advanced: number[] = [];
    const d = new Dispatcher({
      targets: ["exec"],
      concurrency: 3,
      maxAttempts: 1,
      run: (job: Job) =>
        new Promise<string[]>((resolve) =>
          release.set(job.seq, (errors) => {
            if (!errors.length) job.remaining.clear();
            resolve(errors);
          }),
        ),
      onAdvance: (seq) => advanced.push(seq),
      onDead: () => {},
    });
    for (const s of [10, 11, 12, 13]) d.push(makeEvent(s));
    await waitFor(() => release.size === 3, 1000, "three running");
    expect(release.has(13)).toBe(false); // concurrency limit

    release.get(12)!([]);
    await waitFor(() => release.has(13), 1000, "13 starts when a slot frees");
    release.get(11)!([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(advanced).toEqual([]); // 10 is still running: nothing may be acked

    release.get(10)!(["boom"]); // dead (maxAttempts 1) still counts as finished
    await waitFor(() => advanced.length === 1, 1000, "advance");
    expect(advanced).toEqual([12]);
    release.get(13)!([]);
    await waitFor(() => advanced.length === 2, 1000, "advance to 13");
    expect(advanced).toEqual([12, 13]);
    expect(d.finishedThrough).toBe(13);
  });

  it("skips filtered events immediately and ignores duplicates", () => {
    const advanced: number[] = [];
    const d = new Dispatcher({ targets: ["exec"], concurrency: 1, maxAttempts: 1, run: async () => [], onAdvance: (s) => advanced.push(s), onDead: () => {} });
    d.seed(5);
    expect(d.push(makeEvent(4))).toBe(false);
    expect(d.push(makeEvent(6), { skip: true })).toBe(true);
    expect(d.push(makeEvent(6))).toBe(false);
    expect(advanced).toEqual([6]);
  });
});

describe("local filter", () => {
  const ev = makeEvent(1, { message: { from: { name: null, email: "billing@stripe.com" }, subject: "Invoice 2291 paid", labelIds: ["INBOX", "Label_7"] } });
  it("applies the webhook filter model", () => {
    expect(matchesLocal(ev, {})).toBe(true);
    expect(matchesLocal(ev, { types: ["label.added"] })).toBe(false);
    expect(matchesLocal(ev, { filter: { from: ["*@stripe.com"] } })).toBe(true);
    expect(matchesLocal(ev, { filter: { from: ["*@paypal.com"] } })).toBe(false);
    expect(matchesLocal(ev, { filter: { to: ["me@*"] } })).toBe(true);
    expect(matchesLocal(ev, { filter: { subject: "^invoice \\d+" } })).toBe(true);
    expect(matchesLocal(ev, { filter: { subject: "refund" } })).toBe(false);
    expect(matchesLocal(ev, { filter: { labelIds: ["Label_7"] } })).toBe(true);
    expect(matchesLocal(ev, { filter: { labelIds: ["Label_8"] } })).toBe(false);
    // Account events pass message criteria (they only narrow by account).
    expect(matchesLocal(makeEvent(2, { type: "account.auth_failed", message: null }), { filter: { from: ["*@stripe.com"] } })).toBe(true);
  });

  it("builds filters from flags (each group overrides the profile as a unit)", () => {
    const profile = { url: "https://x", apiKey: FAKE_KEY, agentId: "a", agentName: "n", consumer: "c", filter: { from: ["*@old.com"] }, exec: "old" };
    const { config } = resolveListen("default", profile, { from: ["*@stripe.com", "*@stripe.com"], subject: "invoice", forward: "http://localhost:9/x" });
    expect(config.filter).toEqual({ from: ["*@stripe.com"], subject: "invoice" });
    expect(config.exec).toBeNull();
    expect(config.forward?.url).toBe("http://localhost:9/x");
    expect(() => resolveListen("default", profile, { subject: "(" })).toThrow(/regular expression/);
    expect(() => resolveListen("default", profile, { types: "message.received,nope" })).toThrow(/Unknown event type nope/);
    expect(() => resolveListen("default", profile, { forward: "http://example.com/x" })).toThrow(/this machine/);
  });
});

describe("retries and dead letters", () => {
  let api: FakeAgentApi;
  let env: ReturnType<typeof isolateXdg>;
  beforeEach(async () => {
    env = isolateXdg();
    api = await new FakeAgentApi().start();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await api.stop();
    env.restore();
  });

  it("retries with backoff, then writes dead.jsonl, keeps going, and replays", async () => {
    const attempts = join(env.root, "attempts.txt");
    process.env.LISTEN_TEST_OUT = attempts;
    saveProfile("default", { url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
    const ac = new AbortController();
    const delays: number[] = [];
    const run = runListener({
      flags: {
        // Event 1 always fails; the others succeed.
        exec: `echo "$AGENTINBOX_EVENT_SEQ" >> "$LISTEN_TEST_OUT"; [ "$AGENTINBOX_EVENT_SEQ" != 1 ]`,
        maxAttempts: 3,
        from: ["*@example.com"],
        save: true,
      },
      signal: ac.signal,
      retryDelayMs: (n) => {
        delays.push(n);
        return 10;
      },
    });
    await waitFor(() => api.live.size === 1, 5000, "stream");
    api.publish(makeEvent(1));
    api.publish(makeEvent(2));
    api.publish(makeEvent(3, { message: { from: { name: null, email: "x@other.org" } } })); // filtered out
    await waitFor(() => api.acked === 3, 5000, "ack through 3");
    ac.abort();
    await run;

    const lines = readFileSync(attempts, "utf8").trim().split("\n");
    expect(lines.filter((l) => l === "1")).toHaveLength(3);
    expect(lines.filter((l) => l === "2")).toHaveLength(1);
    expect(lines).not.toContain("3");
    expect(delays).toEqual([1, 2]);
    // Acks only move forward (the strict prefix rule is covered by the dispatcher test above).
    expect([...api.acks].sort((a, b) => a - b)).toEqual(api.acks);
    expect(api.acks.at(-1)).toBe(3);

    const dead = readDead("default");
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ seq: 1, id: "evt_1", attempts: 3, targets: ["exec"] });
    expect(dead[0]!.error).toMatch(/Exited with code 1/);
    expect(statSync(deadPath("default")).mode & 0o777).toBe(0o600);

    // --save kept the settings in the profile.
    expect(loadProfile()).toMatchObject({ maxAttempts: 3, filter: { from: ["*@example.com"] } });

    // Replay with a command that now succeeds.
    const failed = await replayDead({ exec: "cat > /dev/null" });
    expect(failed).toBe(0);
    expect(readDead("default")).toHaveLength(0);
    expect(existsSync(deadPath("default"))).toBe(true);
    delete process.env.LISTEN_TEST_OUT;
  });
});
