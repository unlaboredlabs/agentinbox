import { afterEach, describe, expect, it } from "vitest";
import type { Approval, GrantInput } from "../shared/types.ts";
import { ALL_CAPS, connectAgent, decodeRaw, type FakeGmail, grantInput, mailTestContext } from "./mail-fakes.ts";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const ME = "me@acme.com";

function seed(gmail: FakeGmail) {
  gmail.labels.push({ id: "Label_support", name: "Support", type: "user" }, { id: "Label_private", name: "Private", type: "user" });
  gmail
    .add({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD", "Label_support"],
      from: { name: "Alice", email: "alice@client.com" },
      to: [{ name: null, email: ME }],
      cc: [{ name: "Carol", email: "carol@client.com" }],
      subject: "Help with order",
      text: "plain",
      html: "<p>Hi, my order <b>#42</b> is late.</p>",
      messageId: "<m1@client.com>",
      references: ["<m0@client.com>"],
      attachments: [
        { id: "att-txt", filename: "notes.txt", mimeType: "text/plain", data: Buffer.from("order notes") },
        { id: "att-bin", filename: "photo.png", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
    })
    // A later message in t1 without the scope label: the thread stays in scope (thread-level).
    .add({
      id: "m2",
      threadId: "t1",
      labelIds: ["SENT"],
      from: { name: "Me", email: ME },
      to: [{ name: "Alice", email: "alice@client.com" }],
      subject: "Re: Help with order",
      text: "On it.",
    })
    .add({
      id: "m3",
      threadId: "t2",
      labelIds: ["INBOX", "Label_private"],
      from: { name: "Bank", email: "noreply@bank.com" },
      to: [{ name: null, email: ME }],
      subject: "Your statement",
      text: "Balance: $1,000,000",
    });
}

async function setup(grant: Partial<GrantInput> = {}, extraAccount = false) {
  const t = mailTestContext();
  cleanup.push(t.dispose);
  const gmail = t.addAccount("acc_a", ME);
  seed(gmail);
  const grants = [grantInput("acc_a", { capabilities: ALL_CAPS, ...grant })];
  if (extraAccount) {
    t.addAccount("acc_b", "ops@acme.com");
    grants.push(grantInput("acc_b", { capabilities: ALL_CAPS }));
  }
  const { agent } = t.addAgent("bot", grants);
  const mcp = await connectAgent(t.ctx, agent.id, "bot");
  cleanup.push(mcp.close);
  const audits = (action?: string) => t.ctx.audit.list({ agentId: agent.id, action, limit: 200 }).items;
  return { ...t, gmail, agent, ...mcp, audits };
}

describe("reading", () => {
  it("lists accounts with their rules", async () => {
    const s = await setup({ sendMode: "approval", allowTo: ["*@client.com"], maxSendsPerHour: 3, labelScope: ["Label_support"] });
    const r = await s.call("list_accounts");
    expect(r.text).toContain("me@acme.com (account id acc_a)");
    expect(r.text).toContain("queued for human approval");
    expect(r.text).toContain("recipients limited to *@client.com");
    expect(r.text).toContain("limit 3/hour");
    expect(r.text).toContain("limited to threads labeled: Support");
  });

  it("reads a thread with cleaned, wrapped content", async () => {
    const s = await setup();
    const r = await s.call("get_thread", { thread_id: "t1" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Thread t1 in me@acme.com (2 messages");
    expect(r.text).toContain('<email_content from="alice@client.com" untrusted>\nHi, my order **#42** is late.\n</email_content>');
    expect(r.text).toContain("Labels: INBOX, UNREAD, Support");
    expect(r.text).toContain("notes.txt (text/plain, 11 B, attachment_id: att-txt)");
    expect(s.audits("get_thread")[0]).toMatchObject({ outcome: "ok", accountId: "acc_a", target: "t1", detail: { messages: 2 } });
  });

  it("returns text attachments as wrapped text and images as image content", async () => {
    const s = await setup();
    const txt = await s.call("get_attachment", { message_id: "m1", attachment_id: "att-txt" });
    expect(txt.text).toContain("Attachment notes.txt (text/plain, 11 B)");
    expect(txt.text).toContain("untrusted>\norder notes\n</email_content>");
    const img = await s.call("get_attachment", { message_id: "m1", attachment_id: "att-bin" });
    expect(img.content.map((c) => c.type)).toEqual(["text", "image"]);
  });

  it("requires an account argument when several accounts qualify", async () => {
    const s = await setup({}, true);
    const r = await s.call("get_thread", { thread_id: "t1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/pass "account" as one of: me@acme.com, ops@acme.com/);
    expect((await s.call("get_thread", { thread_id: "t1", account: "ME@acme.com" })).isError).toBe(false);
    const nope = await s.call("get_thread", { thread_id: "t1", account: "ceo@acme.com" });
    expect(nope.text).toMatch(/no access to the account/);
    expect(s.audits("get_thread")[0]).toMatchObject({ outcome: "denied", reason: "capability" });
  });

  it("tells the agent to ask for a reconnect when the account needs re-auth", async () => {
    const s = await setup();
    s.ctx.db.run("UPDATE accounts SET status = 'needs_reauth' WHERE id = 'acc_a'");
    const r = await s.call("search_threads", { query: "" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs to be reconnected.*operator.*console/);
    expect(s.audits("search_threads")[0]).toMatchObject({ outcome: "error", reason: "needs_reauth" });
  });

  it("reports missing ids as not found or not accessible", async () => {
    const s = await setup();
    const r = await s.call("get_message", { message_id: "nope" });
    expect(r.text).toMatch(/Message nope was not found or is not accessible/);
    expect(s.audits("get_message")[0]).toMatchObject({ outcome: "error", reason: "not_found" });
  });
});

describe("label scope", () => {
  it("rewrites search queries and post-filters results by thread labels", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    const r = await s.call("search_threads", { query: "from:alice OR from:noreply" });
    expect(s.gmail.queries.at(-1)).toBe("(from:alice OR from:noreply) label:Support");
    // The fake ignores q and returns both threads; t2 must be filtered out.
    expect(r.text).toContain("thread_id: t1");
    expect(r.text).not.toContain("t2");
    expect(r.text).not.toContain("statement");
    expect(s.audits("search_threads")[0]!.detail).toMatchObject({ results: 1, filtered: 1, scoped: true });
  });

  it("rejects unbalanced queries", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    const r = await s.call("search_threads", { query: "x) OR (label:Private" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unmatched/);
    expect(s.gmail.queries).toHaveLength(0);
  });

  it("denies every fetch-by-id outside the scope without revealing existence", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    const attempts: [string, Record<string, unknown>][] = [
      ["get_thread", { thread_id: "t2" }],
      ["get_message", { message_id: "m3" }],
      ["get_attachment", { message_id: "m3", attachment_id: "x" }],
      ["modify_labels", { thread_id: "t2", add: ["STARRED"] }],
      ["archive", { thread_id: "t2" }],
      ["mark_read", { message_id: "m3" }],
      ["trash", { thread_id: "t2" }],
      ["reply", { message_id: "m3", body: "hi" }],
      ["forward", { message_id: "m3", to: "x@client.com" }],
      ["create_draft", { to: "x@client.com", subject: "s", body: "b", thread_id: "t2" }],
    ];
    for (const [tool, args] of attempts) {
      const r = await s.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/was not found or is not accessible to you/);
      expect(s.audits(tool)[0], tool).toMatchObject({ outcome: "denied", reason: "label_scope" });
    }
    // Same message as for a truly missing id.
    const missing = await s.call("get_thread", { thread_id: "t404" });
    expect(missing.text).toBe((await s.call("get_thread", { thread_id: "t2" })).text.replace("t2", "t404"));
    expect(s.gmail.messages.get("m3")!.labelIds).toEqual(["INBOX", "Label_private"]);
    expect(s.gmail.sent).toHaveLength(0);
  });

  it("allows messages in scoped threads even when the message itself lacks the label", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    expect((await s.call("get_message", { message_id: "m2" })).isError).toBe(false);
  });
});

describe("send rules", () => {
  it("checks the allowlist on every recipient, including reply-all and forward", async () => {
    const s = await setup({ allowTo: ["alice@client.com"] });
    const send = await s.call("send_message", { to: "alice@client.com", cc: ["eve@evil.com"], subject: "s", body: "b" });
    expect(send.text).toMatch(/Not allowed to send to eve@evil.com.*only lets you send to: alice@client.com/);
    const all = await s.call("reply", { message_id: "m1", body: "ok", reply_all: true });
    expect(all.text).toMatch(/carol@client.com/);
    const fwd = await s.call("forward", { message_id: "m1", to: "boss@elsewhere.com" });
    expect(fwd.text).toMatch(/boss@elsewhere.com/);
    expect(s.audits().filter((e) => e.reason === "allow_to")).toHaveLength(3);
    const ok = await s.call("reply", { message_id: "m1", body: "ok" });
    expect(ok.isError).toBe(false);
    expect(s.gmail.sent).toHaveLength(1);
  });

  it("reply-only grants hide send_message/forward and deny them per account", async () => {
    const s = await setup({ replyOnly: true });
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("reply");
    expect(tools).not.toContain("send_message");
    expect(tools).not.toContain("forward");

    const mixed = await setup({ replyOnly: true }, true);
    const r = await mixed.call("send_message", { account: ME, to: "alice@client.com", subject: "s", body: "b" });
    expect(r.text).toMatch(/only allows replies inside threads you can see/);
    expect(mixed.audits("send_message")[0]).toMatchObject({ outcome: "denied", reason: "reply_only" });
    expect((await mixed.call("forward", { account: ME, message_id: "m1", to: "a@b.co" })).text).toMatch(/only allows replies/);
    expect((await mixed.call("reply", { account: ME, message_id: "m1", body: "hi" })).isError).toBe(false);
  });

  it("enforces hourly and daily send caps per agent × account", async () => {
    const s = await setup({ maxSendsPerHour: 2, sendMode: "draft_only" });
    for (let i = 0; i < 2; i++) expect((await s.call("send_message", { to: "a@client.com", subject: `s${i}`, body: "b" })).isError).toBe(false);
    const third = await s.call("reply", { message_id: "m1", body: "b" });
    expect(third.text).toMatch(/Send limit reached: 2 of 2 sends in the last hour/);
    expect(s.audits("reply")[0]).toMatchObject({ outcome: "denied", reason: "rate_limit" });
    // Older sends fall out of the window.
    s.ctx.db.run("UPDATE audit_log SET ts = ? WHERE action = 'send_message'", new Date(Date.now() - 2 * 3_600_000).toISOString());
    expect((await s.call("reply", { message_id: "m1", body: "b" })).isError).toBe(false);

    const daily = await setup({ maxSendsPerDay: 1 });
    await daily.call("send_message", { to: "a@client.com", subject: "s", body: "b" });
    expect((await daily.call("send_message", { to: "a@client.com", subject: "s", body: "b" })).text).toMatch(/last 24 hours/);
  });

  it("direct mode sends and kicks ingest", async () => {
    const s = await setup({ sendMode: "direct" });
    const r = await s.call("send_message", { to: "Alice <alice@client.com>, bob@client.com", subject: "Hello", body: "Body", reason: "asked" });
    expect(JSON.parse(r.text)).toMatchObject({ status: "sent", messageId: "sent1" });
    const raw = decodeRaw(s.gmail.sent[0]!.raw);
    expect(raw.to).toEqual([
      { name: "Alice", email: "alice@client.com" },
      { name: null, email: "bob@client.com" },
    ]);
    expect(raw.from).toEqual({ name: "Test User", email: ME });
    expect(s.kicks).toEqual(["acc_a"]);
    expect(s.audits("send_message")[0]).toMatchObject({ outcome: "ok", detail: { mode: "direct", recipients: 2, domains: ["client.com"] } });
  });

  it("draft_only mode saves a draft and says so", async () => {
    const s = await setup({ sendMode: "draft_only" });
    const r = JSON.parse((await s.call("send_message", { to: "alice@client.com", subject: "Hello", body: "Body" })).text);
    expect(r).toEqual({ status: "draft_created", draftId: expect.any(String), message: "Saved as a draft; a human will review and send it from Gmail." });
    expect(s.gmail.drafts.has(r.draftId)).toBe(true);
    expect(s.gmail.sent).toHaveLength(0);
  });

  it("rejects invalid recipients", async () => {
    const s = await setup();
    const r = await s.call("send_message", { to: "not-an-address", subject: "s", body: "b" });
    expect(r.text).toMatch(/not a valid email address/);
    expect(s.audits("send_message")[0]).toMatchObject({ outcome: "error", reason: "invalid_recipient" });
  });
});

describe("replies and forwards", () => {
  it("threads replies and computes reply-all recipients minus the account", async () => {
    const s = await setup();
    await s.call("reply", { message_id: "m1", body: "Thanks!", reply_all: true });
    const sent = s.gmail.sent[0]!;
    expect(sent.threadId).toBe("t1");
    const raw = decodeRaw(sent.raw);
    expect(raw.subject).toBe("Re: Help with order");
    expect(raw.inReplyTo).toBe("<m1@client.com>");
    expect(raw.references).toEqual(["<m0@client.com>", "<m1@client.com>"]);
    expect(raw.to?.map((a) => a.email)).toEqual(["alice@client.com"]);
    expect(raw.cc?.map((a) => a.email)).toEqual(["carol@client.com"]);
  });

  it("replying to the account's own message goes to its original recipients", async () => {
    const s = await setup();
    await s.call("reply", { message_id: "m2", body: "Following up" });
    const raw = decodeRaw(s.gmail.sent[0]!.raw);
    expect(raw.to?.map((a) => a.email)).toEqual(["alice@client.com"]);
    expect(raw.subject).toBe("Re: Help with order");
  });

  it("forwards with a quoted, cleaned original and optional attachments", async () => {
    const s = await setup();
    await s.call("forward", { message_id: "m1", to: "team@acme.com", body: "FYI", include_attachments: true });
    const raw = decodeRaw(s.gmail.sent[0]!.raw);
    expect(s.gmail.sent[0]!.threadId).toBeNull();
    expect(raw.subject).toBe("Fwd: Help with order");
    expect(raw.text).toMatch(/^FYI\n\n---------- Forwarded message ---------\nFrom: Alice <alice@client.com>/);
    expect(raw.text).toContain("Hi, my order **#42** is late.");
    expect(raw.attachments.map((a) => a.filename)).toEqual(["notes.txt", "photo.png"]);
  });
});

describe("approvals", () => {
  async function queue() {
    const s = await setup({ sendMode: "approval" });
    const seen: Approval[] = [];
    s.ctx.bus.on("approval", (a) => seen.push(a));
    const r = JSON.parse((await s.call("reply", { message_id: "m1", body: "Refund approved", reason: "customer asked" })).text);
    expect(r).toMatchObject({ status: "pending_approval", approvalId: expect.stringMatching(/^apr_/) });
    return { ...s, approvalId: r.approvalId as string, seen };
  }

  it("queues a draft + approval and reports status to the agent", async () => {
    const s = await queue();
    const a = s.ctx.mail.getApproval(s.approvalId)!;
    expect(a).toMatchObject({ status: "pending", kind: "reply", agentName: "bot", accountEmail: ME, threadId: "t1", reason: "customer asked", body: "Refund approved" });
    expect(s.gmail.drafts.has(a.draftId)).toBe(true);
    expect(s.seen.map((x) => x.status)).toEqual(["pending"]);
    const ttl = Date.parse(a.expiresAt) - Date.parse(a.createdAt);
    expect(ttl).toBe(72 * 3_600_000);
    const status = JSON.parse((await s.call("get_send_status", { approval_id: s.approvalId })).text);
    expect(status).toMatchObject({ status: "pending", kind: "reply", to: ["alice@client.com"] });
  });

  it("approve sends the draft", async () => {
    const s = await queue();
    const a = await s.ctx.mail.approve(s.approvalId, "lgtm");
    expect(a).toMatchObject({ status: "sent", decisionNote: "lgtm", sentMessageId: "sent2" });
    expect(s.gmail.sent).toHaveLength(1);
    expect(s.seen.map((x) => x.status)).toEqual(["pending", "approved", "sent"]);
    expect(s.kicks).toContain("acc_a");
    await expect(s.ctx.mail.approve(s.approvalId)).rejects.toThrow(/already sent/);
    expect(JSON.parse((await s.call("get_send_status", { approval_id: s.approvalId })).text).status).toBe("sent");
    expect(s.ctx.audit.list({ action: "approval.approve" }).items[0]).toMatchObject({ actorType: "admin", outcome: "ok", target: s.approvalId });
  });

  it("reject deletes the draft", async () => {
    const s = await queue();
    const draftId = s.ctx.mail.getApproval(s.approvalId)!.draftId;
    const a = await s.ctx.mail.reject(s.approvalId, "no");
    expect(a.status).toBe("rejected");
    expect(s.gmail.drafts.has(draftId)).toBe(false);
    expect(s.gmail.sent).toHaveLength(0);
    await expect(s.ctx.mail.reject(s.approvalId)).rejects.toThrow(/already rejected/);
  });

  it("records failed sends", async () => {
    const s = await queue();
    s.gmail.drafts.clear();
    const a = await s.ctx.mail.approve(s.approvalId);
    expect(a.status).toBe("failed");
    expect(a.error).toMatch(/Draft not found/);
  });

  it("expires overdue approvals and deletes their drafts", async () => {
    const s = await queue();
    const draftId = s.ctx.mail.getApproval(s.approvalId)!.draftId;
    expect(await s.ctx.mail.expireApprovals()).toBe(0);
    s.ctx.db.run("UPDATE approvals SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), s.approvalId);
    expect(await s.ctx.mail.expireApprovals()).toBe(1);
    expect(s.ctx.mail.getApproval(s.approvalId)!.status).toBe("expired");
    expect(s.gmail.drafts.has(draftId)).toBe(false);
    await expect(s.ctx.mail.approve(s.approvalId)).rejects.toThrow(/already expired/);
    expect(s.ctx.mail.listApprovals("expired")).toHaveLength(1);
    expect(s.ctx.mail.listApprovals("pending")).toHaveLength(0);
  });

  it("queued approvals count toward send caps; agents can't read others' approvals", async () => {
    const s = await setup({ sendMode: "approval", maxSendsPerDay: 1 });
    await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" });
    expect((await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" })).text).toMatch(/Send limit reached/);
    const other = s.addAgent("other", [grantInput("acc_a", { capabilities: ["send"] })]);
    const mcp = await connectAgent(s.ctx, other.agent.id);
    cleanup.push(mcp.close);
    const id = s.ctx.mail.listApprovals()[0]!.id;
    expect((await mcp.call("get_send_status", { approval_id: id })).text).toMatch(/No send request/);
  });
});

describe("organize and trash", () => {
  it("modifies labels by name or id and blocks protected labels", async () => {
    const s = await setup();
    const r = await s.call("modify_labels", { thread_id: "t1", add: ["support", "STARRED"], remove: ["UNREAD"] });
    expect(r.text).toMatch(/Updated thread t1\. Labels now: .*Starred|STARRED/);
    expect(s.gmail.messages.get("m1")!.labelIds).toEqual(expect.arrayContaining(["STARRED", "Label_support"]));
    expect(s.gmail.messages.get("m1")!.labelIds).not.toContain("UNREAD");
    expect((await s.call("modify_labels", { message_id: "m3", add: ["TRASH"] })).text).toMatch(/Use the trash tool/);
    expect((await s.call("modify_labels", { message_id: "m3", add: ["Nope"] })).text).toMatch(/No label named "Nope"/);
    expect((await s.call("modify_labels", { thread_id: "t1", message_id: "m1", add: ["STARRED"] })).text).toMatch(/exactly one/);
  });

  it("archives, marks read/unread and trashes", async () => {
    const s = await setup();
    await s.call("archive", { thread_id: "t2" });
    expect(s.gmail.messages.get("m3")!.labelIds).not.toContain("INBOX");
    await s.call("mark_read", { message_id: "m1" });
    expect(s.gmail.messages.get("m1")!.labelIds).not.toContain("UNREAD");
    await s.call("mark_read", { thread_id: "t2", read: false });
    expect(s.gmail.messages.get("m3")!.labelIds).toContain("UNREAD");
    const r = await s.call("trash", { thread_id: "t2" });
    expect(r.text).toBe("Moved thread t2 to the trash.");
    expect(s.gmail.messages.get("m3")!.labelIds).toContain("TRASH");
  });
});

describe("events", () => {
  it("lists visible events, formats them compactly and acks", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    const msg = (id: string, labelIds: string[]) => ({
      id,
      threadId: `t-${id}`,
      from: { name: "Alice", email: "alice@client.com" },
      to: [{ name: null, email: ME }],
      cc: [],
      subject: `Subject ${id}`,
      snippet: "snippet text",
      date: "2026-10-14T09:00:00.000Z",
      labelIds,
      hasAttachments: false,
    });
    const base = { accountId: "acc_a", accountEmail: ME, createdAt: "2026-10-14T09:00:00.000Z" };
    s.events.events = [
      { ...base, id: "evt_1", seq: 1, type: "message.received", message: msg("x1", ["INBOX", "Label_support"]) },
      { ...base, id: "evt_2", seq: 2, type: "message.received", message: msg("x2", ["INBOX"]) },
      { ...base, id: "evt_3", seq: 3, type: "sync.gap", message: null, detail: { reason: "history expired" } },
    ];
    const r = await s.call("list_events", { types: ["message.received", "sync.gap"] });
    expect(r.text).toContain("#1 message.received · me@acme.com");
    expect(r.text).toContain("From: Alice <alice@client.com> · To: me@acme.com · Subject: Subject x1");
    expect(r.text).toContain("thread_id: t-x1 · message_id: x1 · labels: INBOX, Support");
    expect(r.text).not.toContain("x2");
    expect(r.text).toContain("#3 sync.gap");
    expect(r.text).toContain("call ack_events with seq=3");
    expect((await s.call("ack_events", { seq: 3 })).text).toBe("Acknowledged up to seq 3.");
    expect((await s.call("wait_for_events", { timeout_seconds: 1 })).text).toMatch(/No new events in the last 1 s/);
    expect((await s.call("list_events", { account: "nobody@x.com" })).isError).toBe(true);
  });
});
