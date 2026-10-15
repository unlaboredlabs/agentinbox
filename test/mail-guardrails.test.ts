// Review + security round: send caps under concurrency, reply-only via drafts, scoped labels and
// attachments, pagination, and approval robustness.

import { afterEach, describe, expect, it } from "vitest";
import type { GrantInput } from "../shared/types.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../server/google/types.ts";
import { ALL_CAPS, connectAgent, decodeRaw, grantInput, mailTestContext } from "./mail-fakes.ts";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const ME = "me@acme.com";
const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup(grant: Partial<GrantInput> = {}) {
  const t = mailTestContext();
  cleanup.push(t.dispose);
  const gmail = t.addAccount("acc_a", ME);
  gmail.labels.push({ id: "Label_support", name: "Support", type: "user" }, { id: "Label_private", name: "Private", type: "user" });
  gmail
    .add({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "Label_support"],
      from: { name: "Alice", email: "alice@client.com" },
      to: [{ name: null, email: ME }],
      cc: [{ name: "Carol", email: "carol@partner.com" }],
      subject: "Help",
      text: "hi",
      attachments: [
        { id: "a1", filename: "a.txt", mimeType: "text/plain", data: Buffer.from("aaa") },
        { id: "a2", filename: "b.txt", mimeType: "text/plain", data: Buffer.from("bbb") },
      ],
    })
    .add({ id: "m3", threadId: "t2", labelIds: ["INBOX", "Label_private"], from: { name: null, email: "x@bank.com" }, to: [{ name: null, email: ME }], subject: "Private", text: "secret" });
  const { agent } = t.addAgent("bot", [grantInput("acc_a", { capabilities: ALL_CAPS, ...grant })]);
  const mcp = await connectAgent(t.ctx, agent.id, "bot");
  cleanup.push(mcp.close);
  const audits = (action?: string) => t.ctx.audit.list({ agentId: agent.id, action, limit: 200 }).items;
  return { ...t, gmail, agent, ...mcp, audits };
}

describe("send caps under concurrency", () => {
  it.each(["direct", "draft_only", "approval"] as const)("never exceeds the cap with parallel calls (%s)", async (sendMode) => {
    const s = await setup({ sendMode, maxSendsPerHour: 1 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => s.call("send_message", { to: `x${i}@client.com`, subject: "s", body: "b" })));
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.filter((r) => /Send limit reached/.test(r.text))).toHaveLength(9);
    expect(s.gmail.sent.length + s.gmail.drafts.size).toBe(1);
    expect((await s.call("send_message", { to: "y@client.com", subject: "s", body: "b" })).isError).toBe(true);
  });

  it("releases the slot when the send fails", async () => {
    const s = await setup({ sendMode: "direct", maxSendsPerHour: 1 });
    const send = s.gmail.send.bind(s.gmail);
    s.gmail.send = async () => {
      throw new GoogleApiError(500, "backend error");
    };
    expect((await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" })).text).toMatch(/Gmail error \(500\)/);
    s.gmail.send = send;
    expect((await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" })).isError).toBe(false);
  });
});

describe("reply-only", () => {
  it("can't reply to its own draft to reach new recipients (PoC M1)", async () => {
    const s = await setup({ replyOnly: true, labelScope: ["Label_support"], sendMode: "direct" });
    const d = await s.call("create_draft", { to: "attacker@evil.com", subject: "Re: Help", body: "loot", thread_id: "t1" });
    const raw = decodeRaw(s.gmail.drafts.get(JSON.parse(d.text).draftId)!.raw);
    // Real Gmail lists the draft as a DRAFT-labelled message in the thread, From = the account.
    s.gmail.add({ id: "dm-x", threadId: "t1", labelIds: ["DRAFT"], from: raw.from, to: raw.to, subject: raw.subject, text: raw.text });
    const r = await s.call("reply", { message_id: "dm-x", body: "secrets" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/is a draft/);
    expect(s.gmail.sent).toHaveLength(0);
  });

  it("a message merely claiming to be from the account (no SENT label) doesn't redirect replies", async () => {
    const s = await setup({ replyOnly: true, sendMode: "direct" });
    s.gmail.add({ id: "fake", threadId: "t1", labelIds: ["INBOX", "Label_support"], from: { name: null, email: ME }, to: [{ name: null, email: "attacker@evil.com" }], subject: "x", text: "x" });
    const r = await s.call("reply", { message_id: "fake", body: "hi" });
    expect(r.text).toMatch(/no one to reply to/);
    expect(s.gmail.sent).toHaveLength(0);
  });

  it("allows replying (and replying all) to people already in the thread", async () => {
    const s = await setup({ replyOnly: true, sendMode: "direct" });
    expect((await s.call("reply", { message_id: "m1", body: "ok", reply_all: true })).isError).toBe(false);
    expect(decodeRaw(s.gmail.sent[0]!.raw).cc?.map((a) => a.email)).toEqual(["carol@partner.com"]);
  });

  it("replies to the Reply-To of a received message", async () => {
    const s = await setup({ replyOnly: true, sendMode: "direct" });
    s.gmail.add({
      id: "m9",
      threadId: "t9",
      labelIds: ["INBOX"],
      from: { name: null, email: "bob@client.com" },
      replyTo: [{ name: null, email: "bob@client.com" }],
      to: [{ name: null, email: ME }],
      subject: "s",
      text: "x",
    });
    expect((await s.call("reply", { message_id: "m9", body: "ok" })).isError).toBe(false);
    expect(decodeRaw(s.gmail.sent[0]!.raw).to?.map((a) => a.email)).toEqual(["bob@client.com"]);
  });
});

describe("allowlist hints", () => {
  it("suggests reply_all: false when only the extra reply-all recipients are blocked", async () => {
    const s = await setup({ allowTo: ["*@client.com"], sendMode: "direct" });
    const r = await s.call("reply", { message_id: "m1", body: "ok", reply_all: true });
    expect(r.text).toMatch(/carol@partner.com.*reply_all: false/);
    expect(s.audits("reply")[0]).toMatchObject({ outcome: "denied", reason: "allow_to" });
  });
});

describe("scoped labels", () => {
  it("list_labels shows only scope labels and system labels", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    const r = await s.call("list_labels");
    expect(r.text).toContain("Support (id Label_support) *");
    expect(r.text).toContain("INBOX");
    expect(r.text).not.toContain("Private");
  });

  it("modify_labels may only add the grant's own scope labels", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    const denied = await s.call("modify_labels", { thread_id: "t1", add: ["Private"] });
    expect(denied.text).toMatch(/"Private" isn't a label you can use\. Labels you can add: Support\./);
    expect(s.audits("modify_labels")[0]).toMatchObject({ outcome: "denied", reason: "label_scope" });
    // Same answer for a label that doesn't exist at all.
    expect((await s.call("modify_labels", { thread_id: "t1", add: ["Nope"] })).text).toMatch(/"Nope" isn't a label you can use/);
    // INBOX/STARRED could be another grant's scope: not addable unless in this grant's scope.
    expect((await s.call("modify_labels", { thread_id: "t1", add: ["INBOX"] })).text).toMatch(/can't add the INBOX label/);
    expect((await s.call("modify_labels", { thread_id: "t1", add: ["STARRED"] })).text).toMatch(/can't add the STARRED label/);
    expect((await s.call("modify_labels", { thread_id: "t1", add: ["Support"], remove: ["INBOX"] })).isError).toBe(false);
    expect(s.gmail.messages.get("m1")!.labelIds).not.toContain("INBOX");
    // Read state stays available through mark_read.
    expect((await s.call("mark_read", { thread_id: "t1", read: false })).isError).toBe(false);
  });

  it("unscoped grants can add any user label", async () => {
    const s = await setup();
    expect((await s.call("modify_labels", { thread_id: "t1", add: ["Private"] })).isError).toBe(false);
  });
});

describe("label cache", () => {
  it("looks labels up again (fresh) when a name or scope label is missing from the cache", async () => {
    const s = await setup({ labelScope: ["Label_support", "Label_new"] });
    s.google.staleLabels.set("acc_a", [...s.gmail.labels]);
    s.gmail.labels.push({ id: "Label_new", name: "New Things", type: "user" });
    await s.call("search_threads", { query: "x" });
    expect(s.gmail.queries.at(-1)).toBe("(x) (label:support OR label:new-things)");
    expect(s.google.labelCalls).toContainEqual({ fresh: true });

    s.google.labelCalls.length = 0;
    expect((await s.call("modify_labels", { thread_id: "t1", add: ["New Things"] })).isError).toBe(false);
    expect(s.google.labelCalls).toEqual([null, { fresh: true }]);

    // A name missing even from a fresh list isn't refetched again right away.
    s.google.labelCalls.length = 0;
    await s.call("modify_labels", { thread_id: "t1", add: ["Nope"] });
    await s.call("modify_labels", { thread_id: "t1", add: ["Nope"] });
    expect(s.google.labelCalls.filter((c) => c?.fresh)).toHaveLength(1);
  });
});

describe("attachments", () => {
  it("fetches by stable part id and never passes unlisted ids to Gmail", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    const asked: string[] = [];
    const get = s.gmail.getAttachment.bind(s.gmail);
    s.gmail.getAttachment = async (m: string, a: string) => {
      asked.push(a);
      return get(m, a);
    };
    const byPart = await s.call("get_attachment", { message_id: "m1", attachment_id: "2" });
    expect(byPart.text).toContain("Attachment b.txt");
    expect(byPart.text).toContain("bbb");
    const unlisted = await s.call("get_attachment", { message_id: "m1", attachment_id: "ATTACHMENT-OF-OUT-OF-SCOPE-MSG" });
    expect(unlisted.isError).toBe(true);
    expect(unlisted.text).toMatch(/has no attachment .*Its attachments: 1 \(a\.txt\), 2 \(b\.txt\)/);
    expect(asked).toEqual(["a2"]);
  });
});

describe("search pagination", () => {
  it("returns the page token even when a page has no visible results", async () => {
    const s = await setup({ labelScope: ["Label_support"] });
    s.gmail.messages.delete("m1");
    s.gmail.nextPageToken = "tok2";
    const r = await s.call("search_threads", { query: "" });
    expect(r.text).toMatch(/No results you can access on this page \(1 skipped\); more may follow\. More results: call again with page_token "tok2"/);
  });
});

describe("events", () => {
  it("mentions more events when the feed says so", async () => {
    const s = await setup();
    const feed = s.ctx.events.feed.bind(s.ctx.events);
    s.ctx.events.feed = (agentId, opts) => ({ ...feed(agentId, opts), hasMore: true }) as ReturnType<typeof feed>;
    expect((await s.call("list_events")).text).toMatch(/More events may be available; call again with after=0/);
  });
});

describe("approval robustness", () => {
  async function queued(grant: Partial<GrantInput> = {}) {
    const s = await setup({ sendMode: "approval", ...grant });
    const r = JSON.parse((await s.call("send_message", { to: "a@client.com", subject: "Hi", body: "b" })).text);
    return { ...s, id: r.approvalId as string };
  }

  it("refuses to send a draft that was edited in Gmail", async () => {
    const s = await queued();
    const a = s.ctx.mail.getApproval(s.id)!;
    s.gmail.drafts.get(a.draftId)!.raw = Buffer.from("edited").toString("base64url");
    const r = await s.ctx.mail.approve(s.id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/changed in Gmail/);
    expect(s.gmail.sent).toHaveLength(0);
    expect(s.gmail.drafts.has(a.draftId)).toBe(true);
  });

  it.each([
    ["rate limit", new GoogleApiError(429, "slow down")],
    ["server error", new GoogleApiError(503, "unavailable")],
    ["needs reauth", new AccountNeedsReauthError("acc_a", ME)],
  ])("returns to pending after a transient failure (%s), and can be approved again", async (_name, err) => {
    const s = await queued();
    s.gmail.sendDraftErrors.push(err);
    const first = await s.ctx.mail.approve(s.id);
    expect(first.status).toBe("pending");
    expect(first.error).toMatch(/Approve again to retry/);
    expect((await s.ctx.mail.approve(s.id)).status).toBe("sent");
  });

  it("recovers approvals interrupted between claim and send", async () => {
    const s = await queued();
    s.ctx.db.run("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?", new Date(Date.now() - 3_600_000).toISOString(), s.id);
    s.ctx.mail.start?.();
    s.ctx.mail.stop?.();
    const a = s.ctx.mail.getApproval(s.id)!;
    expect(a.status).toBe("pending");
    expect(a.error).toMatch(/interrupted/);
  });

  it("re-checks the agent and grant at approval time", async () => {
    const s = await queued();
    s.ctx.db.run("UPDATE grants SET capabilities = '[\"read\"]'");
    await expect(s.ctx.mail.approve(s.id)).rejects.toThrow(/no longer allowed to send/);
    expect(s.ctx.mail.getApproval(s.id)!.status).toBe("rejected");
    expect(s.gmail.sent).toHaveLength(0);
  });

  it.each([
    ["disabling the agent", (s: Awaited<ReturnType<typeof queued>>) => s.ctx.policy.updateAgent(s.agent.id, { disabled: true })],
    ["removing send", (s: Awaited<ReturnType<typeof queued>>) => s.ctx.policy.upsertGrant(s.agent.id, "acc_a", grantInput("acc_a", { capabilities: ["read"] }))],
    ["deleting the grant", (s: Awaited<ReturnType<typeof queued>>) => s.ctx.policy.deleteGrant(s.agent.id, "acc_a")],
  ])("cancels pending approvals and deletes drafts when %s", async (_name, change) => {
    const s = await queued();
    const draftId = s.ctx.mail.getApproval(s.id)!.draftId;
    change(s);
    await tick();
    expect(s.ctx.mail.getApproval(s.id)).toMatchObject({ status: "rejected", decisionNote: expect.stringMatching(/^cancelled: /) });
    expect(s.gmail.drafts.has(draftId)).toBe(false);
  });

  it("deleting the agent deletes its pending drafts", async () => {
    const s = await queued();
    const draftId = s.ctx.mail.getApproval(s.id)!.draftId;
    s.ctx.policy.deleteAgent(s.agent.id);
    await tick();
    expect(s.gmail.drafts.has(draftId)).toBe(false);
    expect(s.ctx.mail.getApproval(s.id)).toBeNull();
  });

  it.each([
    ["the allowlist now excludes a recipient", { allowTo: ["*@other.com"], replyOnly: false }, /may no longer send to a@client.com/],
    ["the grant became reply-only", { allowTo: [] as string[], replyOnly: true }, /may now only send replies/],
  ])("re-applies the current grant at approval time: %s", async (_name, patch, message) => {
    const s = await queued();
    s.ctx.db.run("UPDATE grants SET allow_to = ?, reply_only = ?", JSON.stringify(patch.allowTo), patch.replyOnly ? 1 : 0);
    await expect(s.ctx.mail.approve(s.id)).rejects.toThrow(message);
    expect(s.gmail.sent).toHaveLength(0);
    const status = JSON.parse((await s.call("get_send_status", { approval_id: s.id })).text);
    expect(status.status).toBe("cancelled");
    expect(status.message).toMatch(/^Cancelled automatically/);
  });

  it("treats unexpected errors as permanent failures", async () => {
    const s = await queued();
    s.gmail.sendDraftErrors.push(new TypeError("Cannot read properties of undefined"));
    expect((await s.ctx.mail.approve(s.id)).status).toBe("failed");
  });

  it("treats fetch network failures as transient", async () => {
    const s = await queued();
    s.gmail.sendDraftErrors.push(new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }));
    expect((await s.ctx.mail.approve(s.id)).status).toBe("pending");
  });

  it("get_send_status is read-only: overdue requests read as expired without changing them", async () => {
    const s = await queued();
    s.ctx.db.run("UPDATE approvals SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), s.id);
    expect(JSON.parse((await s.call("get_send_status", { approval_id: s.id })).text).status).toBe("expired");
    expect(s.ctx.mail.getApproval(s.id)!.status).toBe("pending");
  });
});
