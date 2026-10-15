import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { OAUTH_CALLBACK_SCRIPT, OAUTH_CALLBACK_SCRIPT_HASH, OAUTH_CHANNEL } from "../server/api/oauth.ts";
import { createApp } from "../server/app.ts";
import { testContext } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("oauth callback page under the console CSP", () => {
  it("allows exactly the static callback script", async () => {
    const t = testContext();
    dispose = t.dispose;
    const res = await createApp(t.ctx).request("/oauth/callback?error=access_denied&state=x");
    const html = await res.text();
    expect(html).toContain(`<script>${OAUTH_CALLBACK_SCRIPT}</script>`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src ")) ?? "";
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain(`'${OAUTH_CALLBACK_SCRIPT_HASH}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("also posts the result on the console's BroadcastChannel", () => {
    expect(OAUTH_CHANNEL).toBe("agentinbox-oauth");
    expect(OAUTH_CALLBACK_SCRIPT).toContain('new BroadcastChannel("agentinbox-oauth")');
    expect(OAUTH_CALLBACK_SCRIPT).not.toMatch(/\$\{/);
  });

  /** Runs the page script against a fake window; returns what it sent and whether it closed itself. */
  function run(result: Record<string, unknown>, opener: boolean) {
    const sent: { via: string; msg: unknown; target?: string }[] = [];
    let closed = false;
    const timers: (() => void)[] = [];
    const window = {
      opener: opener ? { postMessage: (msg: unknown, target: string) => sent.push({ via: "opener", msg, target }) } : null,
      close: () => (closed = true),
    };
    class BroadcastChannel {
      constructor(readonly name: string) {}
      postMessage(msg: unknown) {
        sent.push({ via: `channel:${this.name}`, msg });
      }
      close() {}
    }
    runInNewContext(OAUTH_CALLBACK_SCRIPT, {
      window,
      BroadcastChannel,
      document: { getElementById: () => ({ textContent: JSON.stringify(result) }) },
      setTimeout: (fn: () => void) => timers.push(fn),
    });
    for (const t of timers) t();
    return { sent, closed };
  }

  it("delivers via both the opener and the channel, and only closes when the opener got it", () => {
    const ok = { ok: true, email: "me@example.com", error: null, targetOrigin: "http://localhost:8425" };
    const msg = { type: "agentinbox:oauth", ok: true, email: "me@example.com", error: null };
    let r = run(ok, true);
    expect(r.sent).toEqual([
      { via: "opener", msg, target: "http://localhost:8425" },
      { via: "channel:agentinbox-oauth", msg },
    ]);
    expect(r.closed).toBe(true);

    // Opener severed (COOP): the channel still gets it and the success page stays up.
    r = run(ok, false);
    expect(r.sent).toEqual([{ via: "channel:agentinbox-oauth", msg }]);
    expect(r.closed).toBe(false);

    r = run({ ok: false, email: null, error: "denied", targetOrigin: "*" }, true);
    expect(r.sent.map((s) => s.via)).toEqual(["opener", "channel:agentinbox-oauth"]);
    expect(r.closed).toBe(false);
  });
});
