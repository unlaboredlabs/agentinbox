// `connections add <url> --yes` and `connections reconnect` for a server that wants a bearer key, end to end: the real
// terminal prompter (hidden input, over fake TTY streams), the real admin API, connector, credential store and remote
// source, against a fake bearer MCP server that accepts only the exact token. It answers like a remote server (with
// latency), so the new connection's first tool listing, sent before the key is saved, is still in flight when the
// key is saved: its 401 must not leave the connection needs_reauth ("rejected the saved API key").

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { upstreams } from "../server/broker/upstream/runtime.ts";
import { addConnection, headerValue, reconnectConnection } from "../server/connections-cli/manage.ts";
import { TerminalPrompter } from "../server/connections-cli/prompt.ts";
import { type Daemon, startDaemon } from "./connections-cli-fake.ts";
import { DEFAULT_TOOLS, type FakeMcpUpstream, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";

const TOKEN = "whp_0123456789abcdefTOKEN";
/** A public-looking https MCP URL like https://whoop.weish.me/api/mcp; the runtime's `dial` sends it to the fake. */
const URL_ = "https://whoop-bearer.test/api/mcp";
/** Fake DNS: the host resolves publicly, so the add takes the public path (key asked before the connection exists). */
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function env(): Promise<{ up: FakeMcpUpstream; d: Daemon; authFailed: string[] }> {
  // ~100 ms per request, like a server across the internet (the user's case); the fake answers 401 to anything
  // without exactly `Authorization: Bearer <TOKEN>`.
  const up = await startFakeMcpUpstream({ protocol: "streamable-2025", path: "/api/mcp", auth: { kind: "bearer", token: TOKEN }, latencyMs: 100 });
  cleanup.push(() => up.close());
  const port = Number(new URL(up.listenOrigin).port);
  const authFailed: string[] = [];
  const d = await startDaemon({
    upstream: {
      lookup: publicDns,
      dial: () => ({ address: "127.0.0.1", port, plain: true }),
      emit: (e) => void (e.type === "connection.auth_failed" && authFailed.push(String(e.detail?.error))),
    },
  });
  cleanup.push(() => d.dispose());
  return { up, d, authFailed };
}

/**
 * The terminal: fake TTY streams under the real TerminalPrompter. Each answer is typed once its prompt shows (as a
 * person would), raw bytes and all: the hidden prompt gets exactly what a terminal in raw mode sends.
 */
function terminal(assumeYes: boolean, answers: { on: RegExp; type: string[] }[]) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      input.isRaw = mode;
      return input;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
  let text = "";
  let since = "";
  output.on("data", (chunk: Buffer) => {
    text += String(chunk);
    since += String(chunk);
    const next = answers[0];
    if (next && next.on.test(since)) {
      answers.shift();
      since = "";
      // Typed after the prompt is up; a paste's chunks arrive one after another.
      setImmediate(() => {
        for (const c of next.type) input.write(c);
      });
    }
  });
  return {
    prompter: new TerminalPrompter(assumeYes, { input, output }),
    // eslint-disable-next-line no-control-regex
    text: () => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""),
    unanswered: () => answers.map((a) => String(a.on)),
  };
}

const deps = (d: Daemon, prompter: TerminalPrompter) => ({ api: d.api, prompter, env: {}, pollMs: 20, timeoutMs: 8000 });
const row = (d: Daemon, slug: string) =>
  d.h.ctx.db.get<{ id: string; status: string; status_reason: string | null; auth_type: string }>("SELECT id, status, status_reason, auth_type FROM connections WHERE slug = ?", slug)!;
const savedHeader = (d: Daemon, id: string) => upstreams(d.h.ctx).store.header(id);

/** `connections add <url> --yes`, typing `typed` at the hidden key prompt. */
async function add(d: Daemon, slug: string, typed: string[]) {
  const t = terminal(true, [{ on: /not shown/, type: typed }]);
  const code = await addConnection(URL_, { yes: true, slug }, deps(d, t.prompter));
  expect(t.unanswered()).toEqual([]);
  return { code, text: t.text() };
}

describe("connections add <bearer URL> --yes: the key typed at the hidden prompt", () => {
  it("a bare token with a trailing CR LF: saved as `Bearer <token>`, active with its tools listed", async () => {
    const { up, d, authFailed } = await env();
    const { code, text } = await add(d, "whoop", [`${TOKEN}\r\n`]);
    expect(text).toContain(`Connected "whoop": ${DEFAULT_TOOLS.length} tools`);
    expect(code).toBe(0);
    const c = row(d, "whoop");
    expect(c).toMatchObject({ status: "active", status_reason: null, auth_type: "header" });
    expect(savedHeader(d, c.id)).toEqual({ name: "Authorization", value: `Bearer ${TOKEN}` });
    expect((await d.api.get(c.id)).tools.total).toBe(DEFAULT_TOOLS.length);
    // The race this guards: the first listing went out without the key (401) while the Connect saved it.
    expect(up.requests.some((r) => r.path === "/api/mcp" && r.status === 401 && !r.headers.authorization)).toBe(true);
    expect(up.requests.some((r) => r.rpcMethod === "tools/list" && r.status === 200 && r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // Never needs_reauth on the way, and the key never printed.
    expect(authFailed).toEqual([]);
    expect(text).not.toContain(TOKEN);
  });

  it('"Bearer <token>" pasted with a trailing newline (and paste markers): the same credential, not "Bearer Bearer …"', async () => {
    const { d } = await env();
    const { code } = await add(d, "whoop", ["\x1b[200~", `Bearer ${TOKEN}`, "\x1b[201~", "\n"]);
    expect(code).toBe(0);
    const c = row(d, "whoop");
    expect(c.status).toBe("active");
    expect(savedHeader(d, c.id)).toEqual({ name: "Authorization", value: `Bearer ${TOKEN}` });
  });
});

describe("connections reconnect <bearer connection>: the same credential as add for the same input", () => {
  it("replaces a rejected key: a bare token with CR LF, then `  bearer   <token>  ` with a newline", async () => {
    const { up, d } = await env();
    // A connection whose saved key the server rejects.
    const t0 = terminal(true, [{ on: /not shown/, type: ["wrong-key\r"] }]);
    expect(await addConnection(URL_, { yes: true, slug: "whoop" }, deps(d, t0.prompter))).toBe(1);
    const c = row(d, "whoop");
    expect(c).toMatchObject({ status: "needs_reauth", status_reason: expect.stringMatching(/rejected the saved API key/) });
    expect(t0.text()).toMatch(/isn't working yet: needs_reauth/);

    for (const typed of [[`${TOKEN}\r\n`], ["  bearer   ", `${TOKEN}  `, "\n"]]) {
      d.h.ctx.db.run("UPDATE connections SET status = 'needs_reauth', status_reason = 'test' WHERE id = ?", c.id);
      // reconnect has no --yes: the header name is asked (Enter takes Authorization), then the key.
      const t = terminal(false, [
        { on: /Header name/, type: ["\r"] },
        { on: /not shown/, type: typed },
      ]);
      expect(await reconnectConnection("whoop", {}, deps(d, t.prompter))).toBe(0);
      expect(t.unanswered()).toEqual([]);
      expect(t.text()).toContain(`Connected "whoop": ${DEFAULT_TOOLS.length} tools`);
      expect(row(d, "whoop")).toMatchObject({ status: "active", status_reason: null });
      expect(savedHeader(d, c.id)).toEqual({ name: "Authorization", value: `Bearer ${TOKEN}` });
    }
    expect(up.requests.filter((r) => r.headers.authorization === "Bearer wrong-key").length).toBeGreaterThan(0);
  });
});

describe("headerValue", () => {
  it("one rule for add and reconnect: CR/LF and surrounding whitespace go; Authorization gets exactly one `Bearer `", () => {
    expect(headerValue("Authorization", "tok\r\n")).toBe("Bearer tok");
    expect(headerValue("authorization", "  tok  ")).toBe("Bearer tok");
    expect(headerValue("Authorization", "Bearer tok\n")).toBe("Bearer tok");
    expect(headerValue("Authorization", "BEARER\ttok")).toBe("Bearer tok");
    expect(headerValue("Authorization", "\r\nbearer    tok \r\n")).toBe("Bearer tok");
    expect(headerValue("Authorization", "Basic dXNlcjpwYXNz")).toBe("Basic dXNlcjpwYXNz");
    expect(headerValue("X-Api-Key", " key-1\r\n")).toBe("key-1");
    expect(headerValue("X-Api-Key", "Bearer key-1")).toBe("Bearer key-1");
  });
});
