// Console-side logic of the setup wizard's last mile: the Verify checks, the commands the console
// prints (they must match what `connect` prints), and grants in plain words.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../shared/agent-api.ts";
import type { AuditEntry, ListenerInfo, MailEvent, SetupState } from "../shared/types.ts";
import { printNextSteps } from "../server/listen/connect.ts";
import type { Profile } from "../server/listen/profile.ts";
import { recipe, shellQuote as cliQuote } from "../server/listen/recipes.ts";
import { grantInWords } from "../src/components/agents/grant-words.ts";
import { listenerHandled } from "../src/components/agents/listener-handled.ts";
import { allStepsDone, type SetupDraft, STEP_META, startsVerify, type StepId, type StepStatus, stepStatuses, wizardStep } from "../src/components/setup/steps.ts";
import { activeTest, TEST_SUBJECT, TEST_TTL_MS, type VerifyTest, verifyChecks } from "../src/components/setup/verify-checks.ts";
import { connectCommands, NPX } from "../src/lib/cli.ts";
import { fmtAgo } from "../src/lib/format.ts";

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

const listener = (consumer: string, ackedSeq: number, connected = true, startSeq: number | null = null, types: ListenerInfo["types"] = null): ListenerInfo => ({
  consumer,
  connected,
  startSeq,
  ackedSeq,
  types,
  lastSeenAt: null,
  client: {},
});
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

describe("listenerHandled", () => {
  const sent = { seq: 7, type: "message.sent" as const };
  const received = { seq: 8, type: "message.received" as const };
  it("needs the event's type among the listener's types", () => {
    const l = listener("x", 9, true, 5, ["message.received"]);
    expect(listenerHandled(l, received)).toBe(true);
    expect(listenerHandled(l, sent)).toBe(false);
  });
  it("counts every type when the types are unknown (cursors from older daemons)", () => {
    const l = listener("x", 9, true, 5, null);
    expect(listenerHandled(l, received)).toBe(true);
    expect(listenerHandled(l, sent)).toBe(true);
  });
  it("needs the event after the cursor's start and at or below the ack", () => {
    expect(listenerHandled(listener("x", 7, true, 7, ["message.received", "message.sent"]), sent)).toBe(false);
    expect(listenerHandled(listener("x", 6, true, 0, ["message.sent"]), sent)).toBe(false);
    expect(listenerHandled(listener("x", 7, true, null, ["message.sent"]), sent)).toBe(true);
  });
});

describe("verifyChecks", () => {
  it("is all false before a test email is sent", () => {
    expect(verifyChecks({ ...base, test: undefined })).toEqual({
      sent: false,
      received: undefined,
      delivered: false,
      resendForListener: false,
      readIt: false,
      typesExcludeIt: null,
    });
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

  it("counts delivery only for event types the listener asked for", () => {
    // The default listener takes message.received only: it acks the test's message.sent without running anything.
    const onlyReceived = [listener("host-default", 9, true, null, ["message.received"])];
    expect(verifyChecks({ ...base, test: test0, events: [event(7, "message.sent")], listeners: onlyReceived }).delivered).toBe(false);
    expect(verifyChecks({ ...base, test: test0, events: [event(8, "message.received"), event(7, "message.sent")], listeners: onlyReceived }).delivered).toBe(true);
    const onlySent = [listener("host-default", 9, true, null, ["message.sent"])];
    expect(verifyChecks({ ...base, test: test0, events: [event(8, "message.received"), event(7, "message.sent")], listeners: onlySent }).delivered).toBe(false);
  });

  it("says when every listener known at send time asked for types without message.received", () => {
    const events = [event(8, "message.received"), event(7, "message.sent")];
    const replies = listener("host-default", 9, true, null, ["thread.reply_received"]);
    expect(verifyChecks({ ...base, test: test0, events, listeners: [replies] }).typesExcludeIt).toEqual(["thread.reply_received"]);
    // Not while one of them takes it, its types are unknown, or the received event hasn't arrived yet.
    const both = [replies, listener("laptop-default", 7, true, null, ["message.received"])];
    expect(verifyChecks({ ...base, test: { ...test0, listenersAtSend: ["host-default", "laptop-default"] }, events, listeners: both }).typesExcludeIt).toBeNull();
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 7)] }).typesExcludeIt).toBeNull();
    expect(verifyChecks({ ...base, test: test0, events: [event(7, "message.sent")], listeners: [replies] }).typesExcludeIt).toBeNull();
    // Only listeners recorded at send time count.
    expect(verifyChecks({ ...base, test: { ...test0, listenersAtSend: [] }, events, listeners: [replies] }).typesExcludeIt).toBeNull();
  });

  it("does not count a listener whose cursor started at or after the event", () => {
    const events = [event(7, "message.received")];
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 9, true, 7)] }).delivered).toBe(false);
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 9, true, 6)] }).delivered).toBe(true);
  });

  it("counts a recorded listener that is disconnected now but acked past the event", () => {
    const r = verifyChecks({ ...base, test: test0, events: [event(7, "message.received")], listeners: [listener("host-default", 7, false)] });
    expect(r.delivered).toBe(true);
    expect(r.resendForListener).toBe(false);
  });

  it("waits for a recorded listener that is disconnected and behind, without asking for a resend", () => {
    // Recorded at send time (even while disconnected): it keeps its cursor and handles the mail on reconnect.
    const r = verifyChecks({ ...base, test: test0, events: [event(7, "message.received")], listeners: [listener("host-default", 5, false)] });
    expect(r.delivered).toBe(false);
    expect(r.resendForListener).toBe(false);
  });

  it("asks for a resend when no recorded listener is connected but another one is", () => {
    const events = [event(7, "message.received")];
    const r = verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 5, false), listener("laptop-default", 9)] });
    expect(r.delivered).toBe(false);
    expect(r.resendForListener).toBe(true);
    // …but not while a recorded listener is connected and still catching up.
    const catchingUp = verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 5), listener("laptop-default", 9)] });
    expect(catchingUp.resendForListener).toBe(false);
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
    // connect prints the command followed by a dry-run hint on the same line.
    expect(cli.some((l) => l === c.setupMcp || l.startsWith(`${c.setupMcp}  `))).toBe(true);
    // The console defers to `--print-recipe`; substituted, it is exactly the command connect prints.
    const recipeExec = cliQuote(recipe(tool).exec);
    const sub = `"$(${NPX} listen --print-recipe ${tool})"`;
    expect(c.listenTry).toContain(sub);
    expect(cli).toContain(c.listenTry.replace(sub, recipeExec));
    // connect prints the bare service install (after --save); the console repeats --exec so it also works alone.
    expect(cli).toContain(`${NPX} listen service install`);
    expect(c.listenService).toBe(`${NPX} listen service install --exec ${sub}`);
    // Neither passes --types: listen's default (new mail only) applies, and connect says so.
    expect(c.listenTry).not.toContain("--types");
    expect(c.listenService).not.toContain("--types");
    expect(cli.some((l) => l.includes("Only new mail wakes it (message.received), not mail you send"))).toBe(true);
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

// ───────────── Stepper: when "Check that it works" is done ─────────────

describe("stepStatuses: the verify step", () => {
  const state = (verified: boolean): SetupState => ({
    claimed: true,
    googleClientConfigured: true,
    gcpProjectId: "p-123456",
    googleAppType: "external",
    pubsub: { mode: "poll", topic: null, subscription: null, lastError: null, lastMessageAt: null, principalAccountId: null, principalEmail: null, pendingPrincipalAccountId: null, pendingPrincipalEmail: null },
    accountsConnected: 1,
    agentsCreated: 1,
    verified,
    complete: true,
    warnings: [],
  });
  const verify = (verified: boolean, draft: SetupDraft) => stepStatuses(state(verified), draft).verify;

  it("follows the server for browsers that never opened the step (old installs, other browsers)", () => {
    expect(verify(true, {})).toBe("done");
    expect(verify(false, {})).toBe("todo");
  });

  it("stays todo once this browser started the step, until Finish", () => {
    // The server has evidence (a tool call) long before the listener and the test email.
    expect(verify(true, { verifyStarted: true })).toBe("todo");
    expect(allStepsDone(stepStatuses(state(true), { verifyStarted: true, pubsubSkipped: true }))).toBe(false);
    // "Finish setup" or "Finish without checking".
    expect(verify(true, { verifyStarted: true, verified: true })).toBe("done");
    expect(verify(false, { verifyStarted: true, verified: true })).toBe("done");
  });

  it("calls setup done without the optional real-time delivery step", () => {
    expect(allStepsDone(stepStatuses(state(true), {}))).toBe(true);
    expect(STEP_META.pubsub.short).toBe("Real-time delivery");
  });
});

// ───────────── Relative times ─────────────

describe("fmtAgo", () => {
  const now = Date.parse(SENT_AT);
  it('says "just now" under 10 seconds instead of "0 seconds ago"', () => {
    expect(fmtAgo(SENT_AT, now)).toBe("just now");
    expect(fmtAgo(later(-9), now)).toBe("just now");
    expect(fmtAgo(later(1), now)).toBe("just now"); // clock skew
    expect(fmtAgo(later(-12), now)).toBe("12 seconds ago");
    expect(fmtAgo(later(-180), now)).toBe("3 minutes ago");
    expect(fmtAgo(later(30), now)).toBe("in 30 seconds");
    expect(fmtAgo(null, now)).toBe("—");
  });
});

describe("wizardStep: which step /get-started shows", () => {
  it("shows ?step= as given and never pins it", () => {
    expect(wizardStep("pubsub", { loaded: true, firstTodo: "consent" })).toEqual({ shown: "pubsub", pin: null });
  });

  it("without ?step=, shows the first unfinished step and pins it once progress has loaded", () => {
    expect(wizardStep(undefined, { loaded: false, firstTodo: undefined })).toEqual({ shown: "verify", pin: null });
    expect(wizardStep(undefined, { loaded: true, firstTodo: "consent" })).toEqual({ shown: "consent", pin: "consent" });
    expect(wizardStep(undefined, { loaded: true, firstTodo: undefined })).toEqual({ shown: "verify", pin: "verify" });
  });

  it("keeps the pinned step after its requirements are met (ticking \"In production\" doesn't jump to step 4)", () => {
    const { pin } = wizardStep(undefined, { loaded: true, firstTodo: "consent" });
    // The page writes the pin into the URL; consent being done now moves firstTodo, not the user.
    expect(wizardStep(pin!, { loaded: true, firstTodo: "client" })).toEqual({ shown: "consent", pin: null });
  });
});

describe("startsVerify: which steps start the end-to-end check in this browser", () => {
  const statuses = (over: Partial<Record<StepId, StepStatus>> = {}): Record<StepId, StepStatus> => ({
    url: "done",
    project: "done",
    consent: "done",
    client: "done",
    accounts: "done",
    pubsub: "skipped",
    agent: "todo",
    verify: "todo",
    ...over,
  });

  it("starts on step 7 while no agent exists, so an early tool call can't complete step 8", () => {
    expect(startsVerify("agent", statuses(), {})).toBe(true);
    // Then the server's evidence arrives (a tool call before step 8 is opened): step 8 stays todo.
    const s = { claimed: true, googleClientConfigured: true, gcpProjectId: "p-123456", googleAppType: "external", accountsConnected: 1, agentsCreated: 1, verified: true } as SetupState;
    expect(stepStatuses({ ...s, pubsub: { mode: "poll" } } as SetupState, { verifyStarted: true }).verify).toBe("todo");
  });

  it("starts on step 8 while it is todo", () => {
    expect(startsVerify("verify", statuses({ agent: "done" }), {})).toBe(true);
  });

  it("doesn't start on an install already verified, or twice", () => {
    expect(startsVerify("verify", statuses({ agent: "done", verify: "done" }), {})).toBe(false);
    expect(startsVerify("agent", statuses({ agent: "done", verify: "done" }), {})).toBe(false);
    expect(startsVerify("verify", statuses({ agent: "done" }), { verifyStarted: true })).toBe(false);
    expect(startsVerify("verify", statuses({ agent: "done" }), { verified: true })).toBe(false);
    // Revisiting step 7 to add a second agent changes nothing.
    expect(startsVerify("agent", statuses({ agent: "done" }), {})).toBe(false);
    expect(startsVerify("accounts", statuses(), {})).toBe(false);
  });
});
