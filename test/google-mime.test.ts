import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../server/context.ts";
import { base64UrlToBuffer, decodeEntities, decodeMimeWords, mimeTools } from "../server/google/mime.ts";
import type { GmailMessage } from "../server/google/types.ts";
import { connectFakeAccount, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const { parse, summarize, compose, parseAddresses } = mimeTools;
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

describe("mime helpers", () => {
  it("parses address lists, including encoded-word names", () => {
    expect(parseAddresses('"Doe, Jane" <jane@x.com>, bob@y.io, =?UTF-8?B?Wm/Dqw==?= <zoe@z.de>')).toEqual([
      { name: "Doe, Jane", email: "jane@x.com" },
      { name: null, email: "bob@y.io" },
      { name: "Zoë", email: "zoe@z.de" },
    ]);
    expect(parseAddresses("")).toEqual([]);
    expect(parseAddresses("undisclosed-recipients:;")).toEqual([]);
  });

  it("decodes encoded-words and snippet entities", () => {
    expect(decodeMimeWords("=?utf-8?q?Caf=C3=A9_au_lait?= =?UTF-8?B?IOKYlQ==?=")).toBe("Café au lait ☕");
    expect(decodeMimeWords("=?iso-8859-1?q?r=E9sum=E9?=")).toBe("résumé");
    expect(decodeEntities("Don&#39;t &amp; won&#x27;t &lt;b&gt; &quot;x&quot;&nbsp;")).toBe("Don't & won't <b> \"x\" ");
  });

  it("summarizes metadata-format messages", () => {
    const msg: GmailMessage = {
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "It&#39;s here",
      internalDate: "1760000000000",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Ann <ann@x.com>" },
          { name: "To", value: "me@y.com, Other <o@y.com>" },
          { name: "Cc", value: "c@z.com" },
          { name: "Subject", value: "Invoice" },
        ],
        body: { size: 0 },
      },
    };
    expect(summarize(msg)).toEqual({
      id: "m1",
      threadId: "t1",
      from: { name: "Ann", email: "ann@x.com" },
      to: [
        { name: null, email: "me@y.com" },
        { name: "Other", email: "o@y.com" },
      ],
      cc: [{ name: null, email: "c@z.com" }],
      subject: "Invoice",
      snippet: "It's here",
      date: new Date(1760000000000).toISOString(),
      labelIds: ["INBOX", "UNREAD"],
      hasAttachments: true,
    });
    expect(summarize({ ...msg, payload: { ...msg.payload!, mimeType: "multipart/alternative" } }).hasAttachments).toBe(false);
  });

  it("parses full messages: charset, nested alternatives, attachments, auth results", () => {
    const latin1 = Buffer.from("Grüße aus Köln", "latin1");
    const msg: GmailMessage = {
      id: "m2",
      threadId: "t2",
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "a@x.com" },
          { name: "Subject", value: "Hi" },
          { name: "Message-ID", value: "<abc@x.com>" },
          { name: "In-Reply-To", value: "<parent@y.com>" },
          { name: "References", value: "<root@y.com>\r\n <parent@y.com>" },
          { name: "Reply-To", value: "Replies <r@x.com>" },
          { name: "Authentication-Results", value: "mx.google.com; spf=pass" },
          { name: "Authentication-Results", value: "mx.google.com; dkim=pass" },
        ],
        body: { size: 0 },
        parts: [
          {
            partId: "0",
            mimeType: "multipart/alternative",
            body: { size: 0 },
            parts: [
              { partId: "0.0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }], body: { size: 14, data: b64(latin1) } },
              { partId: "0.1", mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { size: 20, data: b64("<p>Grüße</p>") } },
            ],
          },
          { partId: "1", mimeType: "text/plain", body: { size: 6, data: b64("footer") } },
          {
            partId: "2",
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            headers: [{ name: "Content-Disposition", value: 'attachment; filename="invoice.pdf"' }],
            body: { attachmentId: "att1", size: 1234 },
          },
          {
            partId: "3",
            mimeType: "image/png",
            filename: "logo.png",
            headers: [{ name: "Content-Disposition", value: "inline" }, { name: "Content-ID", value: "<logo>" }],
            body: { attachmentId: "att2", size: 99 },
          },
        ],
      },
    };
    const p = parse(msg);
    expect(p.text).toBe("Grüße aus Köln");
    expect(p.html).toBe("<p>Grüße</p>");
    expect(p.messageId).toBe("<abc@x.com>");
    expect(p.inReplyTo).toBe("<parent@y.com>");
    expect(p.references).toEqual(["<root@y.com>", "<parent@y.com>"]);
    expect(p.replyTo).toEqual([{ name: "Replies", email: "r@x.com" }]);
    expect(p.headers.subject).toBe("Hi");
    expect(p.attachments).toEqual([
      { id: "att1", filename: "invoice.pdf", mimeType: "application/pdf", size: 1234 },
      { id: "att2", filename: "logo.png", mimeType: "image/png", size: 99 },
    ]);
    expect(p.authenticationResults).toBe("mx.google.com; spf=pass\nmx.google.com; dkim=pass");
    expect(p.summary.hasAttachments).toBe(true);
  });
});

describe("compose → Gmail → parse round trip", () => {
  let fake: FakeGoogle;
  let ctx: AppContext;
  let dispose: () => Promise<void>;
  let accountId: string;

  beforeAll(async () => {
    fake = await startFakeGoogle();
    const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
    ctx = t.ctx;
    dispose = t.dispose;
    accountId = (await connectFakeAccount(ctx, fake, "me@example.com", { name: "Me" })).id;
  });

  afterAll(async () => {
    await dispose();
    await fake.close();
  });

  it("preserves non-ASCII names/subjects, bodies, attachments and threading", async () => {
    const original = fake.deliver("me@example.com", { from: "Zoë Ångström <zoe@example.org>", subject: "Kaffee ☕ morgen?", text: "Hallo!" });
    const gmail = ctx.google.gmail(accountId);
    const parent = parse(await gmail.getMessage(original.id));
    expect(parent.summary.from).toEqual({ name: "Zoë Ångström", email: "zoe@example.org" });
    expect(parent.summary.subject).toBe("Kaffee ☕ morgen?");

    const raw = await compose({
      from: { name: "Mé Ünïcode", email: "me@example.com" },
      to: [parent.summary.from!],
      cc: [{ name: null, email: "cc@example.net" }],
      bcc: [{ name: null, email: "hidden@example.net" }],
      subject: `Re: ${parent.summary.subject}`,
      text: "Ja, gerne! 😀\nBis dann.",
      html: "<p>Ja, gerne! 😀</p>",
      inReplyTo: parent.messageId,
      references: [...parent.references, parent.messageId!],
      attachments: [
        { filename: "Übersicht März.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4 fake") },
        { filename: "notes.txt", content: Buffer.from("plain notes") },
      ],
    });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const rfc = base64UrlToBuffer(raw).toString("utf8");
    expect(rfc).toMatch(/^Bcc: hidden@example\.net/m);
    expect(rfc).not.toMatch(/^Subject: Re: Kaffee ☕/m); // non-ASCII is encoded

    const sent = await gmail.send(raw, parent.summary.threadId);
    expect(sent.labelIds).toContain("SENT");
    const p = parse(await gmail.getMessage(sent.id));
    expect(p.summary.threadId).toBe(original.threadId);
    expect(p.summary.subject).toBe("Re: Kaffee ☕ morgen?");
    expect(p.summary.from).toEqual({ name: "Mé Ünïcode", email: "me@example.com" });
    expect(p.summary.to).toEqual([{ name: "Zoë Ångström", email: "zoe@example.org" }]);
    expect(p.summary.cc).toEqual([{ name: null, email: "cc@example.net" }]);
    expect(p.text?.replace(/\r\n/g, "\n")).toBe("Ja, gerne! 😀\nBis dann.");
    expect(p.html).toBe("<p>Ja, gerne! 😀</p>");
    expect(p.inReplyTo).toBe(parent.messageId);
    expect(p.references).toEqual([parent.messageId]);
    expect(p.attachments.map((a) => [a.filename, a.mimeType])).toEqual([
      ["Übersicht März.pdf", "application/pdf"],
      ["notes.txt", "text/plain"],
    ]);
    const att = await gmail.getAttachment(sent.id, p.attachments[0]!.id);
    expect(base64UrlToBuffer(att.data).toString()).toBe("%PDF-1.4 fake");
    expect(p.summary.hasAttachments).toBe(true);
  });

  it("threads by In-Reply-To when no threadId is given", async () => {
    const first = fake.deliver("me@example.com", { from: "a@example.org", subject: "Plan", text: "?" });
    const parent = parse(await ctx.google.gmail(accountId).getMessage(first.id));
    const raw = await compose({
      from: { name: null, email: "me@example.com" },
      to: [{ name: null, email: "a@example.org" }],
      subject: "Re: Plan",
      text: "ok",
      inReplyTo: parent.messageId,
      references: [parent.messageId!],
    });
    const sent = await ctx.google.gmail(accountId).send(raw);
    expect(sent.threadId).toBe(first.threadId);
  });

  it("creates and sends drafts", async () => {
    const gmail = ctx.google.gmail(accountId);
    const raw = await compose({ from: { name: null, email: "me@example.com" }, to: [{ name: null, email: "x@example.org" }], subject: "Draft", text: "hi" });
    const draft = await gmail.createDraft(raw);
    expect((await gmail.getDraft(draft.id)).message.labelIds).toEqual(["DRAFT"]);
    expect(fake.drafts("me@example.com").map((d) => d.id)).toContain(draft.id);
    const sent = await gmail.sendDraft(draft.id);
    expect(sent.labelIds).toContain("SENT");
    expect(fake.drafts("me@example.com").map((d) => d.id)).not.toContain(draft.id);
    const other = await gmail.createDraft(raw);
    await gmail.deleteDraft(other.id);
    await expect(gmail.getDraft(other.id)).rejects.toMatchObject({ status: 404 });
  });
});
