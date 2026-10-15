import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Address, Attachment, MessageSummary } from "../../shared/types.ts";
import type { ComposeInput, GmailMessage, GmailPart, MimeTools, ParsedMessage } from "./types.ts";

export function base64UrlToBuffer(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function bufferToBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes bytes with the given charset, falling back to UTF-8 for unknown labels. */
export function decodeBytes(bytes: Uint8Array, charset?: string | null): string {
  const label = (charset ?? "utf-8").trim().replace(/^"|"$/g, "").toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Decodes RFC 2047 encoded-words ("=?UTF-8?B?…?="); adjacent encoded-words join without whitespace. */
export function decodeMimeWords(value: string): string {
  if (!value.includes("=?")) return value;
  return value
    .replace(/(\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      const cs = charset.split("*")[0]!;
      if (enc.toUpperCase() === "B") return decodeBytes(Buffer.from(text, "base64"), cs);
      const bytes: number[] = [];
      const q = text.replace(/_/g, " ");
      for (let i = 0; i < q.length; i++) {
        if (q[i] === "=" && /^[0-9a-fA-F]{2}$/.test(q.slice(i + 1, i + 3))) {
          bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(q.charCodeAt(i) & 0xff);
      }
      return decodeBytes(Uint8Array.from(bytes), cs);
    });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Gmail snippets are HTML-escaped ("Don&#39;t"); turn them back into text. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function parseAddresses(value: string | null | undefined): Address[] {
  if (!value?.trim()) return [];
  return addressparser(value, { flatten: true })
    .filter((a) => a.address && a.address.includes("@"))
    .map((a) => ({ name: decodeMimeWords(a.name ?? "").trim() || null, email: a.address.trim() }));
}

function headerMap(part: GmailPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of part?.headers ?? []) {
    const k = h.name.toLowerCase();
    if (!(k in out)) out[k] = decodeMimeWords(h.value);
  }
  return out;
}

function headerParam(value: string | undefined, name: string): string | null {
  if (!value) return null;
  const m = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(value);
  return m ? (m[2] ?? m[1]!) : null;
}

const isAttachmentPart = (p: GmailPart, h: Record<string, string>) =>
  Boolean(p.filename) || /^\s*attachment/i.test(h["content-disposition"] ?? "");

function hasAttachmentParts(part: GmailPart | undefined): boolean {
  if (!part) return false;
  if (part.filename) return true;
  return (part.parts ?? []).some(hasAttachmentParts);
}

function toIso(msg: GmailMessage, dateHeader: string | undefined): string {
  const ms = Number(msg.internalDate);
  if (msg.internalDate && Number.isFinite(ms)) return new Date(ms).toISOString();
  const parsed = dateHeader ? Date.parse(dateHeader) : NaN;
  return new Date(Number.isNaN(parsed) ? Date.now() : parsed).toISOString();
}

export function summarize(msg: GmailMessage): MessageSummary {
  const h = headerMap(msg.payload);
  const parts = msg.payload?.parts;
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: parseAddresses(h.from)[0] ?? null,
    to: parseAddresses(h.to),
    cc: parseAddresses(h.cc),
    subject: h.subject ?? "",
    snippet: decodeEntities(msg.snippet ?? ""),
    date: toIso(msg, h.date),
    labelIds: msg.labelIds ?? [],
    // format=metadata has no parts: approximate with the top-level type.
    hasAttachments: parts ? hasAttachmentParts(msg.payload) : msg.payload?.mimeType?.toLowerCase() === "multipart/mixed",
  };
}

export function parse(msg: GmailMessage): ParsedMessage {
  const headers = headerMap(msg.payload);
  let text: string | null = null;
  let html: string | null = null;
  const attachments: Attachment[] = [];

  const walk = (part: GmailPart) => {
    const h = headerMap(part);
    const type = (part.mimeType || "text/plain").toLowerCase();
    if (type.startsWith("multipart/")) {
      for (const child of part.parts ?? []) walk(child);
      return;
    }
    if (isAttachmentPart(part, h) || type === "message/rfc822") {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({ id: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType, size: part.body.size ?? 0 });
      }
      return;
    }
    if (type !== "text/plain" && type !== "text/html") return;
    if ((type === "text/plain" ? text : html) !== null || !part.body?.data) return;
    const decoded = decodeBytes(base64UrlToBuffer(part.body.data), headerParam(h["content-type"], "charset"));
    if (type === "text/plain") text = decoded;
    else html = decoded;
  };
  if (msg.payload) walk(msg.payload);

  const authResults = (msg.payload?.headers ?? [])
    .filter((x) => x.name.toLowerCase() === "authentication-results")
    .map((x) => x.value);
  const ids = (v: string | undefined) => v?.match(/<[^<>\s]+>/g) ?? [];

  return {
    summary: summarize(msg),
    headers,
    messageId: ids(headers["message-id"])[0] ?? (headers["message-id"]?.trim() || null),
    inReplyTo: ids(headers["in-reply-to"])[0] ?? (headers["in-reply-to"]?.trim() || null),
    references: ids(headers.references),
    replyTo: parseAddresses(headers["reply-to"]),
    text,
    html,
    attachments,
    authenticationResults: authResults.length ? authResults.join("\n") : null,
  };
}

const addr = (a: Address) => (a.name ? { name: a.name, address: a.email } : a.email);
const addrs = (list: Address[] | undefined) => (list?.length ? list.map(addr) : undefined);

export async function compose(input: ComposeInput): Promise<string> {
  const node = new MailComposer({
    from: addr(input.from),
    to: addrs(input.to),
    cc: addrs(input.cc),
    bcc: addrs(input.bcc),
    replyTo: addrs(input.replyTo),
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references?.length ? input.references : undefined,
    attachments: input.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  // Gmail reads Bcc recipients from the raw message (and drops the header for other recipients).
  node.keepBcc = true;
  return bufferToBase64Url(await node.build());
}

export const mimeTools: MimeTools = { parse, summarize, compose, parseAddresses };
