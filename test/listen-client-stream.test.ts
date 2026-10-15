import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, runListener, type RunListenerOptions } from "../server/listen/listen.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { readStatus } from "../server/listen/state.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

let api: FakeAgentApi;
let env: ReturnType<typeof isolateXdg>;
let out: string;
let output = "";

beforeEach(async () => {
  env = isolateXdg();
  api = await new FakeAgentApi().start();
  out = join(env.root, "handled.txt");
  // Inherited by the command (only AGENTINBOX_* variables are stripped).
  process.env.LISTEN_TEST_OUT = out;
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
  saveProfile("default", {
    url: api.url,
    apiKey: FAKE_KEY,
    agentId: "agt_1",
    agentName: "Test agent",
    consumer: "testhost-default",
    exec: `printf '%s\\n' "$AGENTINBOX_EVENT_SEQ" >> "$LISTEN_TEST_OUT"`,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LISTEN_TEST_OUT;
  await api.stop().catch(() => {});
  env.restore();
});

const handled = () => (existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);

function start(extra: Partial<RunListenerOptions> = {}) {
  const ac = new AbortController();
  const done = runListener({ flags: {}, signal: ac.signal, minBackoffMs: 50, maxBackoffMs: 200, retryDelayMs: () => 20, ...extra });
  return { stop: () => ac.abort(), done };
}

describe("listen stream", () => {
  it("resumes after drops and a daemon restart without losing or duplicating events", async () => {
    const l = start();
    await waitFor(() => api.live.size === 1, 5000, "stream");
    expect(api.streamRequests[0]).toMatchObject({ consumer: "testhost-default", authorization: `Bearer ${FAKE_KEY}`, lastEventId: null });
    expect(api.streamRequests[0]!.userAgent).toMatch(/^agentinbox\//);

    for (const s of [1, 2, 3]) api.publish(makeEvent(s));
    await waitFor(() => handled().length === 3, 5000, "first batch");

    // Network drop mid-stream; events keep arriving at the daemon meanwhile.
    api.dropConnections();
    for (const s of [4, 5, 6]) api.publish(makeEvent(s));
    await waitFor(() => handled().length === 6, 5000, "second batch");
    const reconnect = api.streamRequests[1]!;
    expect(Number(reconnect.lastEventId)).toBeGreaterThanOrEqual(3);

    // The daemon goes away entirely and comes back on the same port.
    await api.stop();
    api.events.push(makeEvent(7));
    await new Promise((r) => setTimeout(r, 300));
    await api.restart();
    await waitFor(() => handled().length === 7, 8000, "after restart");
    await waitFor(() => api.acked === 7, 5000, "final ack");

    expect(handled().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    l.stop();
    expect(await l.done).toBe(EXIT.ok);
    const st = readStatus("default")!;
    expect(st).toMatchObject({ ackedSeq: 7, receivedSeq: 7, connected: false, exitReason: "stopped" });
    expect(output).toContain("Connected");
    expect(output).toContain("Disconnected");
    expect(output).not.toContain(FAKE_KEY);
  });

  it("detects a stalled stream (no pings) and reconnects", async () => {
    api.sendPings = false;
    const l = start({ stallMs: 300 });
    await waitFor(() => api.streamRequests.length >= 3, 5000, "reconnects after stalls");
    expect(output).toMatch(/stream stalled/);
    l.stop();
    await l.done;
  });

  it("exits with the revoked code on `event: revoked`", async () => {
    const l = start();
    await waitFor(() => api.live.size === 1, 5000, "stream");
    api.revoke("the agent's key was rotated");
    expect(await l.done).toBe(EXIT.revoked);
    expect(output).toContain("Access revoked: the agent's key was rotated");
    expect(output).toContain("connect");
    expect(readStatus("default")!.exitReason).toMatch(/revoked/);
  });

  it("exits with the revoked code when the key is rejected (401)", async () => {
    api.keyValid = false;
    const l = start();
    expect(await l.done).toBe(EXIT.revoked);
    expect(output).toContain("Access revoked");
  });

  it("passes types and include_body to the daemon and keeps the server cursor in charge", async () => {
    api.acked = 5;
    for (const s of [3, 4, 5, 6]) api.events.push(makeEvent(s));
    const l = start({ flags: { types: "message.received,label.added", includeBody: true } });
    await waitFor(() => handled().length === 1, 5000, "event after the cursor");
    expect(handled()).toEqual([6]);
    expect(api.streamRequests[0]).toMatchObject({ types: "message.received,label.added", includeBody: "1" });
    l.stop();
    await l.done;
  });
});
