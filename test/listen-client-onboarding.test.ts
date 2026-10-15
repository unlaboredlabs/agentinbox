// Zero-context onboarding of the agent-side CLI: what `connect`, `setup-mcp` and `listen` tell a
// first-time user (actual grant, approve link, MCP changes, backfill, transport refusals, next steps).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../server/config.ts";
import { printStatus } from "../server/listen/admin.ts";
import { approveLinks, CONNECT_EXIT, runConnect } from "../server/listen/connect.ts";
import { describeGrant, describeGrants } from "../server/listen/grants.ts";
import { EXIT, runListener, type RunListenerOptions } from "../server/listen/listen.ts";
import { acquireProfileLock, backfillLockPath, lockPath } from "../server/listen/lock.ts";
import { helperScriptPath } from "../server/listen/mcpheader.ts";
import { setupMcp } from "../server/listen/mcpsetup.ts";
import { readStatus } from "../server/listen/state.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { checkTransport } from "../server/listen/transport.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

let api: FakeAgentApi;
let env: ReturnType<typeof isolateXdg>;
let output = "";

beforeEach(async () => {
  env = isolateXdg();
  api = await new FakeAgentApi().start();
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.stop().catch(() => {});
  env.restore();
});

// eslint-disable-next-line no-control-regex
const plain = () => output.replace(/\x1b\[[0-9;]*m/g, "");
const approved = () => ({
  status: "approved" as const,
  apiKey: FAKE_KEY,
  agent: { id: "agt_1", name: "Claude Code on testhost" },
  mcpUrl: `${api.url}/mcp`,
  skillUrl: `${api.url}/skill.md`,
});
const baseProfile = () => ({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c", exec: "cat > /dev/null" });
function start(extra: Partial<RunListenerOptions> = {}) {
  const ac = new AbortController();
  const done = runListener({ flags: {}, signal: ac.signal, minBackoffMs: 50, maxBackoffMs: 200, blockedRetryMs: 100, ...extra });
  return { stop: () => ac.abort(), done };
}

describe("grants in plain words", () => {
  const g = (capabilities: string[], sendMode: "draft_only" | "approval" | "direct", labelScope: string[] | null = null) =>
    ({ accountId: "a", accountEmail: "ops@acme.dev", capabilities, labelScope, sendMode }) as Parameters<typeof describeGrant>[0];

  it("matches the console's choices", () => {
    expect(describeGrant(g(["read"], "draft_only"))).toBe("ops@acme.dev: read only (can't draft or send)");
    expect(describeGrant(g(["read", "draft", "send"], "draft_only"))).toBe("ops@acme.dev: read, draft, send; sends become Gmail drafts for you to send");
    expect(describeGrant(g(["read", "draft", "send", "organize"], "approval"))).toBe("ops@acme.dev: read, draft, send, organize; sends need your approval in the console");
    expect(describeGrant(g(["read", "draft", "send"], "direct"))).toBe("ops@acme.dev: read, draft, send; sends go out directly");
    expect(describeGrant(g(["read", "draft"], "draft_only"))).toBe("ops@acme.dev: read, draft; can't send");
    expect(describeGrant(g(["read"], "draft_only", ["INBOX"]))).toContain("only labels INBOX");
    expect(describeGrants([])[0]).toMatch(/no mailbox access yet/);
  });
});

describe("connect", () => {
  it("prints the grant the approver actually chose (not a draft-only boilerplate)", async () => {
    api.grants = [{ accountId: "acc_1", accountEmail: "ops@acme.dev", capabilities: ["read", "draft", "send", "organize"], labelScope: null, sendMode: "approval" }];
    api.pollScript = [approved()];
    expect(await runConnect(api.url, { tool: "claude-code" }, { pollIntervalMs: 10 })).toBe(CONNECT_EXIT.approved);
    expect(plain()).toContain("Access granted");
    expect(plain()).toContain("ops@acme.dev: read, draft, send, organize; sends need your approval in the console");
    expect(plain()).not.toMatch(/New grants are draft-only/);
    expect(output).not.toContain(FAKE_KEY);
  });

  it("says so when no mailbox was granted", async () => {
    api.grants = [];
    api.pollScript = [approved()];
    await runConnect(api.url, {}, { pollIntervalMs: 10 });
    expect(plain()).toContain("no mailbox access yet");
  });

  it("uses the address the CLI connected to for the approve link when the public URL differs", async () => {
    api.publicUrl = `http://localhost:${api.port}`;
    api.pollScript = [{ status: "expired" }];
    await runConnect(api.url, {}, { pollIntervalMs: 10 });
    const lines = plain().split("\n");
    const open = lines.find((l) => l.includes("Open:"))!;
    expect(open).toContain(`${api.url}/approvals?pairing=K7QM-2XPD`);
    const or = lines.find((l) => l.includes("or:"))!;
    expect(or).toContain(`http://localhost:${api.port}/approvals?pairing=K7QM-2XPD`);
    expect(plain()).toContain("the console's public URL");
  });

  it("approveLinks: same origin keeps the daemon's link; a path prefix we connected through is kept", () => {
    const start = { userCode: "AB12-CD34", verificationUrl: "http://localhost:8425/approvals?pairing=AB12-CD34" };
    expect(approveLinks("http://localhost:8425", start)).toEqual({ primary: start.verificationUrl, publicUrl: null });
    expect(approveLinks("http://127.0.0.1:8425", start)).toEqual({ primary: "http://127.0.0.1:8425/approvals?pairing=AB12-CD34", publicUrl: start.verificationUrl });
    expect(approveLinks("https://box.example.com/agentinbox", start).primary).toBe("https://box.example.com/agentinbox/approvals?pairing=AB12-CD34");
  });

  it("next steps: foreground listen first, then the console's test email, then the service", async () => {
    api.pollScript = [approved()];
    await runConnect(api.url, { tool: "claude-code" }, { pollIntervalMs: 10 });
    const text = plain();
    const fg = text.indexOf("First try it in the foreground");
    const check = text.indexOf('"Check that it works"');
    const svc = text.indexOf("listen service install");
    expect(fg).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(fg);
    expect(svc).toBeGreaterThan(check);
    expect(text).toContain("test email");
    expect(text).toContain("listen --save --exec");
  });
});

describe("setup-mcp", () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, HERMES_HOME: process.env.HERMES_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  let home: string;
  beforeEach(() => {
    home = join(env.root, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    delete process.env.CODEX_HOME;
    delete process.env.HERMES_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const target = { name: "agentinbox", url: "https://mail.example.com/mcp", key: FAKE_KEY, profile: "default" };

  it("--dry-run lists the exact Claude Code commands and changes nothing", () => {
    const bin = join(env.root, "bin");
    mkdirSync(bin);
    const log = join(env.root, "claude-called");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho called >> ${log}\nexit 0\n`);
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    writeFileSync(join(home, ".claude.json"), "{}");

    const r = setupMcp("claude-code", target, "/p.json", { dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true });
    const text = r.changes!.join("\n");
    expect(text).toContain("run: claude mcp remove agentinbox --scope user");
    expect(text).toContain("run: claude mcp add-json --scope user agentinbox '");
    expect(text).toContain("headersHelper");
    expect(text).toContain(`back up ${join(home, ".claude.json")}`);
    expect(r.verify!.join(" ")).toContain("claude mcp list");
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(helperScriptPath())).toBe(false);
    expect(readdirSync(home).filter((f) => f.includes("backup"))).toEqual([]);
  });

  it("--dry-run for Codex, Cursor and Hermes shows the file, the entry (key redacted) and writes nothing", () => {
    const codex = setupMcp("codex", target, "/p.json", { dryRun: true });
    expect(codex.changes!.join("\n")).toContain(join(home, ".codex", "config.toml"));
    expect(codex.changes!.join("\n")).toContain("[mcp_servers.agentinbox]");
    expect(codex.verify!.join(" ")).toContain("codex mcp list");
    const cursor = setupMcp("cursor", target, "/p.json", { dryRun: true });
    expect(cursor.changes!.join("\n")).toContain(join(home, ".cursor", "mcp.json"));
    const hermes = setupMcp("hermes", target, "/p.json", { dryRun: true });
    expect(hermes.changes!.join("\n")).toContain("AGENTINBOX_API_KEY=<the key from your agentinbox profile>");
    expect(hermes.verify!.join(" ")).toContain("hermes mcp test agentinbox");
    for (const r of [codex, cursor, hermes]) {
      expect(r.dryRun).toBe(true);
      expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    }
    expect(readdirSync(home)).toEqual([]);
  });

  it("a real run says how to verify", () => {
    const r = setupMcp("codex", target, "/p.json");
    expect(r.ok).toBe(true);
    expect(r.verify).toEqual([expect.stringContaining("codex mcp list")]);
  });
});

describe("listen", () => {
  it("shows the access in plain words and logs a grant change", async () => {
    saveProfile("default", baseProfile());
    const l = start({ grantsRefreshMs: 100 });
    await waitFor(() => plain().includes("me@example.com: read, draft; can't send"), 5000, "initial grants");
    expect(plain()).not.toContain("draft_only");
    api.grants = [{ accountId: "acc_1", accountEmail: "me@example.com", capabilities: ["read", "draft", "send"], labelScope: null, sendMode: "approval" }];
    await waitFor(() => plain().includes("Access changed in the console"), 5000, "grant change");
    expect(plain()).toContain("me@example.com: read, draft, send; sends need your approval in the console");
    const changes = plain().match(/Access changed/g)!.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(plain().match(/Access changed/g)!.length).toBe(changes); // only on a change
    l.stop();
    await l.done;
  });

  it("listen status reports the access in plain words", async () => {
    saveProfile("default", baseProfile());
    await printStatus("default");
    expect(plain()).toMatch(/Access\s+me@example.com: read, draft; can't send/);
  });

  it("--backfill runs stored events once next to a running listener, then exits", async () => {
    saveProfile("default", baseProfile());
    for (const s of [1, 2, 3]) api.events.push(makeEvent(s));
    // The profile's listener (e.g. its service) holds the profile lock.
    const releaseListener = acquireProfileLock("default");
    const runs = join(env.root, "runs.txt");
    const bf = start({ flags: { backfill: true, exec: `cat >> /dev/null; echo "$AGENTINBOX_EVENT_SEQ" >> ${runs}` }, backfillIdleMs: 300 });
    const code = await bf.done;
    expect(code).toBe(EXIT.ok);
    expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["1", "2", "3"]);
    expect(api.streamRequests.at(-1)).toMatchObject({ consumer: "c-replay", start: "beginning" });
    expect(api.acks).toEqual([]); // never moves a cursor
    expect(plain()).toContain("Backfill done: 3 events handled");
    // The listener's lock and status.json are untouched; the backfill's own lock is gone.
    expect(existsSync(lockPath("default"))).toBe(true);
    expect(existsSync(backfillLockPath("default"))).toBe(false);
    expect(readStatus("default")).toBeNull();
    releaseListener();
  });

  it("--backfill stops at the head and leaves newer mail alone; nothing stored is a no-op", async () => {
    saveProfile("default", baseProfile());
    expect(await start({ flags: { backfill: true } }).done).toBe(EXIT.ok);
    expect(plain()).toContain("No stored events to backfill yet");

    // #3 arrived after the backfill read the head (#2): it's the listener's job.
    for (const s of [1, 2, 3]) api.events.push(makeEvent(s));
    api.headSeq = 2;
    const runs = join(env.root, "runs2.txt");
    const bf = start({ flags: { backfill: true, exec: `echo "$AGENTINBOX_EVENT_SEQ" >> ${runs}` }, backfillIdleMs: 60_000 });
    expect(await bf.done).toBe(EXIT.ok);
    expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["1", "2"]);
  });

  it("the backfill hint names a command that works, with targets that weren't saved", async () => {
    saveProfile("default", { ...baseProfile(), exec: undefined });
    const l = start({ flags: { exec: "my-handler --x" } });
    await waitFor(() => api.live.size === 1, 5000, "stream");
    expect(plain()).toContain("npx agentinbox-cli listen --backfill --exec 'my-handler --x'");
    l.stop();
    await l.done;
  });
});

describe("transport refusal for *.ts.net", () => {
  it("says what the name resolved to and suggests an SSH tunnel or https", async () => {
    const err = await checkTransport("http://box.tail1234.ts.net:8425", { resolve: async () => ["203.0.113.7"] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("box.tail1234.ts.net resolved to 203.0.113.7, which is not a Tailscale address");
    expect(msg).toContain("ssh -N -L 8425:localhost:8425 <user>@box.tail1234.ts.net");
    expect(msg).toContain("http://localhost:8425");
    expect(msg).toContain("https://");
    const unresolved = await checkTransport("http://box.tail1234.ts.net:8425", { resolve: async () => [] }).catch((e: Error) => e.message);
    expect(unresolved).toContain("could not be resolved here");
    expect(unresolved).toMatch(/Tailscale running/);
  });
});

describe("data directory notice", () => {
  it("only mentions tightening a directory that already held files", () => {
    const root = mkdtempSync(join(tmpdir(), "aib-data-"));
    try {
      const fresh = join(root, "fresh");
      loadConfig({ dataDir: fresh });
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
      const empty = join(root, "empty");
      mkdirSync(empty, { mode: 0o755 });
      chmodSync(empty, 0o755);
      loadConfig({ dataDir: empty });
      expect(statSync(empty).mode & 0o777).toBe(0o700);
      expect(output).not.toContain("readable by other users");

      const used = join(root, "used");
      mkdirSync(used);
      writeFileSync(join(used, "agentinbox.db"), "");
      chmodSync(used, 0o755);
      loadConfig({ dataDir: used });
      expect(statSync(used).mode & 0o777).toBe(0o700);
      expect(output).toContain("readable by other users");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
