// Console-side logic of the setup wizard's last mile: the Verify checks, the commands the console
// prints (they must match what `connect` prints), and grants in plain words.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../shared/agent-api.ts";
import type { AuditEntry, ListenerInfo, MailEvent } from "../shared/types.ts";
import { printNextSteps } from "../server/listen/connect.ts";
import type { Profile } from "../server/listen/profile.ts";
import { recipe, shellQuote as cliQuote } from "../server/listen/recipes.ts";
import { grantInWords } from "../src/components/agents/grant-words.ts";
import { activeTest, TEST_SUBJECT, TEST_TTL_MS, type VerifyTest, verifyChecks } from "../src/components/setup/verify-checks.ts";
import { connectCommands, NPX } from "../src/lib/cli.ts";

// ───────────── Verify checks ─────────────

const SENT_AT = "2026-10-15T10:00:00.000Z";
const later = (s: number) => new Date(Date.parse(SENT_AT) + s * 1000).toISOString();

const test0: VerifyTest = { messageId: "m1", threadId: "t1", sentAt: SENT_AT, accountId: "acc_1", listenersAtSend: ["host-default"] };

function event(seq: number, type: MailEvent["type"], over: { id?: string; subject?: string; createdAt?: string; accountId?: string } = {}): MailEvent {
  return {
    id: `evt_${seq}`,
    seq,
    type,
    accountId: over.accountId ?? "acc_1",
    accountEmail: "me@example.com",
    createdAt: over.createdAt ?? later(2),
    message: {
      id: over.id ?? "m1",
      threadId: "t1",
      from: { name: null, email: "me@example.com" },
      to: [],
      cc: [],
      subject: over.subject ?? TEST_SUBJECT,
      snippet: "",
      date: SENT_AT,
      labelIds: [],
      hasAttachments: false,
    },
  };
}

const listener = (consumer: string, ackedSeq: number, connected = true): ListenerInfo => ({ consumer, connected, ackedSeq, lastSeenAt: null, client: {} });
const call = (action: string, outcome: AuditEntry["outcome"], ts: string): AuditEntry => ({
  id: 1,
  ts,
  actorType: "agent",
  actorId: "agt_1",
  actorName: "a",
  action,
  accountId: null,
  target: null,
  outcome,
  reason: null,
  durationMs: 1,
  detail: null,
});

const base = { events: [] as MailEvent[], listeners: [] as ListenerInfo[], calls: [] as AuditEntry[], skipListen: false };

describe("verifyChecks", () => {
  it("is all false before a test email is sent", () => {
    expect(verifyChecks({ ...base, test: undefined })).toEqual({ sent: false, received: undefined, delivered: false, resendForListener: false, readIt: false });
  });

  it("matches the test by message id and prefers message.received over message.sent", () => {
    const r = verifyChecks({ ...base, test: test0, events: [event(2, "message.received"), event(1, "message.sent"), event(3, "message.received", { id: "other", subject: "hi" })] });
    expect(r.sent).toBe(true);
    expect(r.received?.seq).toBe(2);
  });

  it("falls back to the subject for events after the send, but not older ones or other accounts", () => {
    const sameSubjectAfter = event(5, "message.received", { id: "m-other", createdAt: later(3) });
    const sameSubjectBefore = event(4, "message.received", { id: "m-old", createdAt: later(-60) });
    const otherAccount = event(6, "message.received", { id: "m1", accountId: "acc_2" });
    expect(verifyChecks({ ...base, test: test0, events: [sameSubjectAfter] }).received?.seq).toBe(5);
    expect(verifyChecks({ ...base, test: test0, events: [sameSubjectBefore] }).received).toBeUndefined();
    expect(verifyChecks({ ...base, test: test0, events: [otherAccount] }).received).toBeUndefined();
  });

  it("counts delivery only from listeners that were connected when the test was sent", () => {
    const events = [event(7, "message.received")];
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 7)] }).delivered).toBe(true);
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 6)] }).delivered).toBe(false);
  });

  it("does not count a listener that connected after the send, and asks for another test email", () => {
    const events = [event(7, "message.received")];
    // A new listener's cursor starts at the newest event, so its ackedSeq passes the test without handling it.
    const r = verifyChecks({ ...base, test: { ...test0, listenersAtSend: [] }, events, listeners: [listener("host-default", 9)] });
    expect(r.delivered).toBe(false);
    expect(r.resendForListener).toBe(true);
    const other = verifyChecks({ ...base, test: test0, events, listeners: [listener("laptop-default", 9)] });
    expect(other.delivered).toBe(false);
  });

  it("doesn't ask for a resend when the listener is skipped", () => {
    const r = verifyChecks({ ...base, skipListen: true, test: { ...test0, listenersAtSend: [] }, events: [event(7, "message.received")], listeners: [listener("x", 9)] });
    expect(r.resendForListener).toBe(false);
    expect(r.received?.seq).toBe(7);
  });

  it("counts only successful reads after the send", () => {
    const at = (calls: AuditEntry[]) => verifyChecks({ ...base, test: test0, calls }).readIt;
    expect(at([call("get_thread", "ok", later(5))])).toBe(true);
    expect(at([call("search_threads", "denied", later(5))])).toBe(false);
    expect(at([call("get_message", "error", later(5))])).toBe(false);
    expect(at([call("get_thread", "ok", later(-5))])).toBe(false);
    expect(at([call("list_accounts", "ok", later(5))])).toBe(false);
  });

  it("forgets a test email after an hour", () => {
    expect(activeTest(test0, Date.parse(SENT_AT) + 1000)).toBe(test0);
    expect(activeTest(test0, Date.parse(SENT_AT) + TEST_TTL_MS + 1)).toBeUndefined();
    expect(activeTest(undefined, 0)).toBeUndefined();
  });
});

// ───────────── Commands: console vs `connect` ─────────────

/** Minimal POSIX word splitting (quotes and backslashes; no expansion), to check quoting round-trips. */
function words(cmd: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      cur = (cur ?? "") + cmd.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      let s = "";
      for (; cmd[j] !== '"'; j++) s += cmd[j] === "\\" ? cmd[++j] : cmd[j];
      cur = (cur ?? "") + s;
      i = j;
    } else if (ch === "\\") {
      cur = (cur ?? "") + cmd[++i];
    } else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else {
      cur = (cur ?? "") + ch;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

function nextSteps(tool: AgentTool, url: string): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    lines.push(...String(s).split("\n"));
    return true;
  });
  try {
    const profile = { url, apiKey: "aib_test", agentId: "agt_1", agentName: "a", consumer: "host-default", mcpUrl: `${url}/mcp` } as unknown as Profile;
    printNextSteps("default", profile, tool, null);
  } finally {
    spy.mockRestore();
  }
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean);
}

describe("connectCommands matches what `connect` prints", () => {
  afterEach(() => vi.restoreAllMocks());
  const URL_ = "https://mail.example.com";
  const known: AgentTool[] = ["claude-code", "codex", "cursor", "hermes"];

  it.each([...known, "other" as const])("skill install for %s", (tool) => {
    expect(nextSteps(tool, URL_)).toContain(connectCommands(URL_, tool).skillInstall);
  });

  it.each(known)("setup-mcp, listen try and service for %s", (tool) => {
    const c = connectCommands(URL_, tool);
    const cli = nextSteps(tool, URL_);
    expect(cli).toContain(c.setupMcp);
    // The console defers to `--print-recipe`; substituted, it is exactly the command connect prints.
    const recipeExec = cliQuote(recipe(tool).exec);
    const sub = `"$(${NPX} listen --print-recipe ${tool})"`;
    expect(c.listenTry).toContain(sub);
    expect(cli).toContain(c.listenTry.replace(sub, recipeExec));
    // connect prints the bare service install (after --save); the console repeats --exec so it also works alone.
    expect(cli).toContain(`${NPX} listen service install`);
    expect(c.listenService).toBe(`${NPX} listen service install --exec ${sub}`);
  });

  it("other: the service runs the same script connect suggests; the try command is a harmless test", () => {
    const c = connectCommands(URL_, "other");
    expect(nextSteps("other", URL_)).toContain(c.listenService.replace("listen service install", "listen --save"));
    expect(c.listenTry).toBe(`${NPX} listen --exec 'cat > /dev/null'`);
    expect(c.connect).toBe(`${NPX} connect ${URL_} --tool other`);
  });

  it.each(["https://mail.example.com/it's", "https://mail.example.com/a b", "http://127.0.0.1:8712"])("quotes the URL %s so the shell passes it unchanged", (url) => {
    const c = connectCommands(url, "claude-code");
    expect(words(c.connect)).toEqual(["npx", "agentinbox-cli", "connect", url, "--tool", "claude-code", "--setup-mcp"]);
    expect(words(c.skillInstall).at(-1)).toBe(url);
  });

  it("adds --insecure only after the explicit opt-in, and only for plain http off loopback/Tailscale", () => {
    expect(connectCommands("http://192.168.1.20:8425", "codex").connect).not.toContain("--insecure");
    expect(connectCommands("http://192.168.1.20:8425", "codex", true).connect).toContain("--insecure");
    expect(connectCommands("http://192.168.1.20:8425", "codex", true).listenTry).toContain("--insecure");
    expect(connectCommands("http://127.0.0.1:8425", "codex", true).connect).not.toContain("--insecure");
  });
});

// ───────────── Grants in plain words ─────────────

describe("grantInWords", () => {
  it("never reads as sending for draft_only", () => {
    expect(grantInWords({ capabilities: ["read", "draft", "send"], sendMode: "draft_only" })).toBe("Can read and save drafts; can't send");
    expect(grantInWords({ capabilities: ["read", "send"], sendMode: "draft_only" })).toBe("Can read and save drafts; can't send");
  });
  it("read only", () => {
    expect(grantInWords({ capabilities: ["read"], sendMode: "draft_only" })).toBe("Can read; can't change or send anything");
  });
  it("approval and direct sending", () => {
    expect(grantInWords({ capabilities: ["read", "draft", "send", "organize"], sendMode: "approval" })).toBe("Can read, save drafts, organize and send once you approve");
    expect(grantInWords({ capabilities: ["read", "draft", "send", "organize", "trash"], sendMode: "direct" })).toBe("Can read, save drafts, organize, trash and send");
  });
  it("nothing granted", () => {
    expect(grantInWords({ capabilities: [], sendMode: "direct" })).toBe("No access");
  });
});
