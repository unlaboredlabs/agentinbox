// Content cleaning in worker threads: deadlines, fallbacks and a responsive event loop under hostile mail.

import { afterEach, describe, expect, it } from "vitest";
import type { ParsedMessage } from "../server/google/types.ts";
import { buildContent, escapeDelimiters } from "../server/mail/content.ts";
import { ContentPool } from "../server/mail/pool.ts";
import { createLogger } from "../server/util/log.ts";

const log = createLogger("test").child("content");
const OPTS = { accountEmail: "me@acme.com", maxChars: 0 };
const pools: ContentPool[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
});
const pool = (opts?: ConstructorParameters<typeof ContentPool>[1]) => {
  const p = new ContentPool(log, opts);
  pools.push(p);
  return p;
};

const message = (html: string | null, text: string | null = null): ParsedMessage => ({
  summary: { id: "m1", threadId: "t1", from: { name: null, email: "x@evil.example" }, to: [], cc: [], subject: "s", snippet: "", date: "", labelIds: [], hasAttachments: false },
  headers: {},
  messageId: null,
  inReplyTo: null,
  references: [],
  replyTo: [],
  text,
  html,
  attachments: [],
  authenticationResults: null,
});

/** Runs `fn` while sampling event-loop lag every 10 ms; returns the result, wall time and worst lag. */
async function measure<T>(fn: () => Promise<T>) {
  let worst = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  const t0 = performance.now();
  try {
    const result = await fn();
    return { result, ms: performance.now() - t0, lag: worst };
  } finally {
    clearInterval(probe);
  }
}

describe("content pool", () => {
  it("returns the same content as in-process cleaning", async () => {
    const p = pool();
    const m = message('<p>Hello <b>there</b></p><div style="display:none">hidden</div>');
    expect(await p.content(m, OPTS)).toEqual(buildContent(m, OPTS));
    expect((await p.html("<h1>T</h1>")).markdown).toBe("# T");
  });

  it("falls back to the text part when the deadline passes, then keeps working", async () => {
    const p = pool({ deadlineMs: 1 });
    const slow = message(`<table>${"<tr><td>cell</td><td>x</td></tr>".repeat(4000)}</table>`, "Plain version.");
    const c = await p.content(slow, OPTS);
    expect(c.truncated).toBe(true);
    expect(c.body).toBe("[This message is too complex to display safely; showing its plain-text version.]\n\nPlain version.");
    const none = await p.content(message(slow.html), OPTS);
    expect(none.body).toMatch(/too complex to display safely\. Ask a human/);
    const relaxed = pool({ deadlineMs: 5_000 });
    expect((await relaxed.content(message("<p>ok</p>"), OPTS)).body).toBe("ok");
  });

  it("keeps the event loop responsive and every hostile message under 3 s", async () => {
    const p = pool();
    const hostile = {
      selectorBacktracking: `<style>section div div div div div div div div{display:none}</style>${"<div>".repeat(60)}x`,
      deepNesting: "<div>".repeat(19_000) + "x",
      tooManyElements: "<div>".repeat(50_000) + "x",
      flatInline: "<b>x</b>".repeat(50_000),
      rulesTimesElements: `<style>${Array.from({ length: 8000 }, (_, i) => `.c${i}{display:none}`).join("")}</style>${'<div class="c1 a b">t</div>'.repeat(10_000)}`,
      longWhitespace: `<pre>a${" ".repeat(400_000)}b</pre>`,
    };
    for (const [name, html] of Object.entries(hostile)) {
      const m = await measure(() => p.content(message(html, "fallback text"), OPTS));
      expect(m.ms, name).toBeLessThan(3_000);
      expect(m.lag, name).toBeLessThan(250);
      expect(m.result.body.length, name).toBeGreaterThan(0);
    }
  });

  it("cleans in-process when workers can't start", async () => {
    const p = pool({ workerUrl: new URL("./does-not-exist.js", import.meta.url) });
    expect((await p.content(message("<p>inline</p>"), OPTS)).body).toBe("inline");
  });

  it("resolves pending work with the fallback on close", async () => {
    const p = new ContentPool(log, { deadlineMs: 60_000 });
    const pending = p.content(message(`<p>${"x ".repeat(10)}</p>`, "text"), OPTS);
    await p.close();
    expect((await pending).body.length).toBeGreaterThan(0);
  });
});

describe("linear-time helpers on 40k-character inputs", () => {
  const time = (fn: () => unknown) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  it.each([
    ["delimiter escaping (spaces)", () => escapeDelimiters("<" + " ".repeat(40_000))],
    ["delimiter escaping (angle brackets)", () => escapeDelimiters("<".repeat(40_000))],
    ["zero-length check", () => buildContent(message(`<p style="font-size:${"0".repeat(40_000)}x">a</p>`), OPTS)],
    ["background shorthand", () => buildContent(message(`<p style="background:${"a-".repeat(20_000)}">a</p>`), OPTS)],
    ["comment with brackets", () => buildContent(message(`<!--${"<".repeat(40_000)}-->`), OPTS)],
    ["auth results parentheses", () => buildContent({ ...message(null, "x"), authenticationResults: "mx.google.com; " + "(".repeat(40_000) }, OPTS)],
    ["role-spoof pattern on blank lines", () => buildContent(message(null, "\n".repeat(40_000) + "x"), OPTS)],
  ])("%s", (_name, fn) => {
    fn();
    expect(time(fn)).toBeLessThan(20);
  });
});
