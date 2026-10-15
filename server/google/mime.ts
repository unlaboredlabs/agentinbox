import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Address, Attachment, MessageSummary } from "../../shared/types.ts";
import type { ComposeInput, GmailClient, GmailMessage, GmailPart, LargeBody, MimeTools, ParsedMessage } from "./types.ts";

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

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

function wordBytes(enc: string, text: string): Buffer {
  if (enc.toUpperCase() === "B") return Buffer.from(text, "base64");
  const bytes: number[] = [];
  const q = text.replace(/_/g, " ");
  for (let i = 0; i < q.length; i++) {
    if (q[i] === "=" && /^[0-9a-fA-F]{2}$/.test(q.slice(i + 1, i + 3))) {
      bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(q.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

/**
 * Decodes RFC 2047 encoded-words ("=?UTF-8?B?…?="). Whitespace between adjacent encoded-words is
 * dropped, and runs with the same charset are decoded together (a multibyte character may be split
 * across words). Line breaks and NULs in the result become spaces.
 */
export function decodeMimeWords(value: string): string {
  if (!value.includes("=?")) return value;
  const parts: (string | { charset: string; chunks: Buffer[] })[] = [];
  let last = 0;
  for (const m of value.matchAll(ENCODED_WORD)) {
    const between = value.slice(last, m.index);
    const charset = m[1]!.split("*")[0]!.toLowerCase();
    const bytes = wordBytes(m[2]!, m[3]!);
    const prev = parts.at(-1);
    const adjacent = typeof prev === "object" && /^\s*$/.test(between);
    if (adjacent && prev.charset === charset) prev.chunks.push(bytes);
    else {
      if (!adjacent) parts.push(between);
      parts.push({ charset, chunks: [bytes] });
    }
    last = m.index + m[0].length;
  }
  parts.push(value.slice(last));
  return parts
    .map((p) => (typeof p === "string" ? p : decodeBytes(Buffer.concat(p.chunks), p.charset)))
    .join("")
    .replace(/[\r\n\0]+/g, " ");
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

/**
 * Header values longer than this are cut before decoding or address parsing: any sender controls them,
 * and nodemailer's addressparser costs ~1 µs per character of group syntax on the main thread.
 */
export const MAX_HEADER_CHARS = 16_384;

/**
 * Parses an address header from its raw value. Encoded-words are decoded only inside display names,
 * after parsing, so an encoded name can never inject extra addresses ("=?UTF-8?B?…?= <evil@x>").
 */
export function parseAddresses(value: string | null | undefined): Address[] {
  if (!value?.trim()) return [];
  return addressparser(value.slice(0, MAX_HEADER_CHARS), { flatten: true })
    .filter((a) => a.address && a.address.includes("@") && !/[\s<>,;"]|=\?|\?=/.test(a.address.trim()))
    .map((a) => ({ name: decodeMimeWords(a.name ?? "").trim() || null, email: a.address.trim() }));
}

/** Free-text headers whose encoded-words are decoded. Structured headers (addresses, ids) stay raw. */
const TEXT_HEADERS = new Set(["subject", "comments", "keywords", "thread-topic"]);

/** Lower-cased name → first value; only free-text headers are RFC 2047-decoded. */
function headerMap(part: GmailPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of part?.headers ?? []) {
    const k = h.name.toLowerCase();
    if (k in out) continue;
    const value = h.value.slice(0, MAX_HEADER_CHARS);
    out[k] = TEXT_HEADERS.has(k) ? decodeMimeWords(value) : value;
  }
  return out;
}

/** The first `<id>` token of a Message-ID style header, never free text. */
function msgIds(v: string | undefined): string[] {
  return v?.match(/<[^<>\s]+>/g) ?? [];
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
  if (part.filename || (part.body?.attachmentId && part.mimeType?.toLowerCase() === "message/rfc822")) return true;
  return (part.parts ?? []).some(hasAttachmentParts);
}

const EXT: Record<string, string> = { "message/rfc822": "eml", "text/plain": "txt", "text/html": "html", "text/calendar": "ics", "application/pdf": "pdf" };

/** A name for attachments without a filename (forwarded messages, nameless parts). */
function generatedName(part: GmailPart, h: Record<string, string>): string {
  const type = part.mimeType.toLowerCase();
  if (type === "message/rfc822") {
    const subject = /(?:^|\n)Subject:\s*(.+)/i.exec(h["content-description"] ?? "")?.[1] ?? h["content-description"];
    return `${(subject ? decodeMimeWords(subject) : "forwarded-message").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80)}.eml`;
  }
  return `attachment-${part.partId || "1"}.${EXT[type] ?? type.split("/")[1]?.replace(/[^a-z0-9]+/g, "") ?? "bin"}`;
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
  const largeBodies: LargeBody[] = [];

  const walk = (part: GmailPart) => {
    const h = headerMap(part);
    const type = (part.mimeType || "text/plain").toLowerCase();
    if (type.startsWith("multipart/")) {
      for (const child of part.parts ?? []) walk(child);
      return;
    }
    if (isAttachmentPart(part, h) || type === "message/rfc822") {
      if (part.body?.attachmentId) {
        const filename = part.filename || generatedName(part, h);
        attachments.push({ id: part.body.attachmentId, filename, mimeType: part.mimeType, size: part.body.size ?? 0 });
      }
      return;
    }
    if (type !== "text/plain" && type !== "text/html") return;
    if ((type === "text/plain" ? text : html) !== null) return;
    const charset = headerParam(h["content-type"], "charset");
    if (!part.body?.data) {
      // Very large bodies come by reference; loadLargeBodies() fetches them.
      if (part.body?.attachmentId && !largeBodies.some((b) => b.kind === (type === "text/plain" ? "text" : "html"))) {
        largeBodies.push({ kind: type === "text/plain" ? "text" : "html", attachmentId: part.body.attachmentId, charset });
      }
      return;
    }
    const decoded = decodeBytes(base64UrlToBuffer(part.body.data), charset);
    if (type === "text/plain") text = decoded;
    else html = decoded;
  };
  if (msg.payload) walk(msg.payload);

  const authResults = (msg.payload?.headers ?? [])
    .filter((x) => x.name.toLowerCase() === "authentication-results")
    .map((x) => x.value);
  return {
    summary: summarize(msg),
    headers,
    messageId: msgIds(headers["message-id"])[0] ?? null,
    inReplyTo: msgIds(headers["in-reply-to"])[0] ?? null,
    references: msgIds(headers.references),
    replyTo: parseAddresses(headers["reply-to"]),
    text,
    html,
    attachments,
    authenticationResults: authResults.length ? authResults.join("\n") : null,
    ...(largeBodies.length ? { largeBodies } : {}),
  };
}

/**
 * Fills in text/html bodies that Gmail returned by attachmentId (very large parts), which `parse`
 * can't fetch synchronously. No-op when the parsed message has none.
 */
export async function loadLargeBodies(gmail: Pick<GmailClient, "getAttachment">, messageId: string, parsed: ParsedMessage): Promise<ParsedMessage> {
  if (!parsed.largeBodies?.length) return parsed;
  const out = { ...parsed };
  for (const b of parsed.largeBodies) {
    const { data } = await gmail.getAttachment(messageId, b.attachmentId);
    out[b.kind] = decodeBytes(base64UrlToBuffer(data), b.charset);
  }
  delete out.largeBodies;
  return out;
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
