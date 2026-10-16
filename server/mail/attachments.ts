// Files an agent attaches to a draft, reply or new message (the `attachments` tool argument). Everything
// is checked here, in plain words, before anything reaches Google: base64, type, size against Gmail's
// limits, the file types Gmail refuses, and the filename (cleaned like other untrusted header text).

import { createHash } from "node:crypto";
import { detectExtension, detectMimeType } from "nodemailer/lib/mime-funcs";
import { decodeMimeWords } from "../google/mime.ts";
import { escapeDelimiters, formatSize, stripInvisible } from "./content.ts";

/** The tool argument, one item per file. */
export interface AttachmentInput {
  filename: string;
  mime_type?: string;
  content_base64: string;
}

/** A checked attachment, ready for the MIME composer. */
export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** Audit and approval view: never the content. */
export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  sha256?: string;
}

/** Files per message. Gmail itself takes far more; this keeps tool calls and approval cards readable. */
export const MAX_ATTACHMENTS = 10;
/**
 * Gmail's sending limit: 25 MB for the message content and attachments together, before encoding
 * (support.google.com/mail/answer/6584, and the Workspace sending limits). Counted in decimal megabytes,
 * the stricter reading.
 */
export const MAX_MESSAGE_BYTES = 25_000_000;
/** Longest filename kept (code points), extension included. */
export const MAX_FILENAME_CHARS = 120;

/**
 * File types Gmail refuses to send, as listed on "File types blocked in Gmail"
 * (support.google.com/mail/answer/6590). Gmail also blocks them compressed (.gz, .bz2) and inside archives;
 * archives aren't opened here, so Gmail may still refuse a .zip that contains one.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd", "com", "cpl", "diagcab", "diagcfg",
  "diagpkg", "dll", "dmg", "ex", "ex_", "exe", "hta", "img", "ins", "iso", "isp", "jar", "jnlp", "js", "jse",
  "lib", "lnk", "mde", "mjs", "msc", "msi", "msix", "msixbundle", "msp", "mst", "nsh", "pif", "ps1", "scr",
  "sct", "shb", "sys", "vb", "vbe", "vbs", "vhd", "vxd", "wsc", "wsf", "wsh", "xll",
]);
/** Single-file compression Gmail looks through ("x.exe.gz" is blocked like "x.exe"). */
const COMPRESSED = new Set(["gz", "bz2", "xz", "z", "zst", "lz", "lzma"]);

/** RFC 6838 type/subtype (restricted-name), no parameters. */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
/** Standard or url-safe base64, padding optional. Whitespace (line wrapping) is removed first. */
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
/** C0/C1 controls and DEL, plus the bidi marks stripInvisible keeps in text (LRM, RLM, ALM). */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point here
const CONTROL_OR_MARK = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c]/g;
/** An extension worth keeping when the name is cut: short, letters/digits (and "_" for "ex_"). */
const EXTENSION = /\.([\p{L}\p{N}_]{1,16})$/u;
// Alternation, not a class: U+1160 and U+FE0F would combine with a neighbour inside one.
const TRAILING_JUNK = /(?:[\s.\u115F\u180E\u3164\uFFA0]|\u1160|\uFE0F)+$/u;
const NTFS_STREAM = /(?::[^:/\\]*)?:\$[A-Za-z_]+$/;

export class AttachmentError extends Error {
  constructor(
    readonly code: "invalid_attachment" | "too_many_attachments" | "too_large" | "blocked_file_type",
    message: string,
  ) {
    super(message);
  }
}

/** Gmail's extension for a MIME type, or null when nodemailer doesn't know one. */
function extensionFor(mimeType: string): string | null {
  const ext = detectExtension(mimeType);
  return ext && ext !== "bin" && ext !== "*" && /^[a-z0-9]{1,10}$/i.test(ext) ? ext.toLowerCase() : null;
}

/** An RFC 2047 encoded-word ("=?charset?B|Q?text?="). */
const ENCODED_WORD = /=\?[^?\s]+\?[bq]\?[^?\s]*\?=/i;

/**
 * The filename as it will appear in the message: no path, no control, zero-width, bidi or tag characters,
 * our delimiter tags defused, at most MAX_FILENAME_CHARS with the extension kept. Falls back to
 * "attachment" (plus the extension for `mimeType`, when known).
 */
export function sanitizeFilename(name: string, mimeType = "application/octet-stream"): string {
  // Bounded input: anything past a few times the cap is never shown.
  let s = String(name ?? "").slice(0, MAX_FILENAME_CHARS * 8);
  // Mail clients decode RFC 2047 encoded-words in filenames ("=?UTF-8?B?ZXZpbC5leGU=?=" is evil.exe), so
  // every check below must see the decoded name. Nested encodings are unwrapped too, a few rounds at most.
  for (let round = 0; round < 5; round++) {
    const decoded = decodeMimeWords(s);
    if (decoded === s) break;
    s = decoded.slice(0, MAX_FILENAME_CHARS * 8);
  }
  s = stripInvisible(s).text.replace(CONTROL_OR_MARK, "");
  s = s.split(/[/\\]/).at(-1) ?? "";
  s = trimTail(escapeDelimiters(s).replace(/\s+/g, " ").trim());
  if (s === "." || s === ".." || !s.replace(/\./g, "")) s = "";
  if (!s) {
    const ext = extensionFor(mimeType);
    return ext ? `attachment.${ext}` : "attachment";
  }
  const chars = Array.from(s);
  if (chars.length <= MAX_FILENAME_CHARS) return s;
  const ext = EXTENSION.exec(s)?.[0] ?? "";
  const keep = MAX_FILENAME_CHARS - Array.from(ext).length - 1;
  return `${chars.slice(0, keep).join("").trimEnd()}…${ext}`;
}

/**
 * Trailing characters that hide the real extension: whitespace, dots, invisible fillers (variation selector
 * U+FE0F, Hangul fillers U+115F/U+1160/U+3164/U+FFA0, Mongolian vowel separator U+180E) and an NTFS stream
 * suffix ("::$DATA", ":name:$DATA"). Removed until none is left.
 */
function trimTail(s: string): string {
  for (;;) {
    const next = s.replace(TRAILING_JUNK, "").replace(NTFS_STREAM, "");
    if (next === s) return s;
    s = next;
  }
}

/** The extension Gmail would block this file for, or null. Looks through one layer of compression. */
export function blockedExtension(filename: string): string | null {
  const parts = trimTail(filename).toLowerCase().split(".").slice(1);
  let ext = parts.at(-1);
  if (ext && COMPRESSED.has(ext) && parts.length >= 2) {
    const inner = parts.at(-2)!;
    if (BLOCKED_EXTENSIONS.has(inner)) return `${inner}.${ext}`;
  }
  return ext && BLOCKED_EXTENSIONS.has(ext) ? ext : null;
}

/** Decoded size of a (whitespace-free) base64 string, without decoding it. */
function decodedSize(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor(((b64.length - pad) * 3) / 4);
}

/**
 * Checks and decodes the agent's attachments. `bodyBytes` (the message text) counts toward Gmail's 25 MB.
 * Throws AttachmentError with a message the agent can act on.
 */
export function prepareAttachments(input: AttachmentInput[] | undefined, bodyBytes = 0): OutgoingAttachment[] {
  if (!input?.length) return [];
  if (input.length > MAX_ATTACHMENTS) {
    throw new AttachmentError("too_many_attachments", `At most ${MAX_ATTACHMENTS} attachments per message; you passed ${input.length}.`);
  }
  // Sizes first, from the base64 length: nothing is decoded when the total is over the limit.
  const items = input.map((a, i) => {
    const label = `Attachment ${i + 1}${typeof a.filename === "string" && a.filename.trim() ? ` (${sanitizeFilename(a.filename)})` : ""}`;
    const b64 = typeof a.content_base64 === "string" ? a.content_base64.replace(/\s+/g, "") : "";
    if (!b64) throw new AttachmentError("invalid_attachment", `${label} is empty: put the file's bytes, base64-encoded, in content_base64.`);
    if (!BASE64.test(b64) || b64.length % 4 === 1 || (b64.includes("=") && b64.length % 4 !== 0)) {
      throw new AttachmentError(
        "invalid_attachment",
        `${label}: content_base64 is not valid base64. Encode the file's bytes with standard or url-safe base64 (no "data:" prefix).`,
      );
    }
    return { a, i, label, b64, size: decodedSize(b64) };
  });
  const total = bodyBytes + items.reduce((n, x) => n + x.size, 0);
  if (total > MAX_MESSAGE_BYTES) {
    throw new AttachmentError(
      "too_large",
      `The message would be ${formatSize(total)}; Gmail sends at most 25 MB per message (body and attachments together). ` +
        "Send fewer or smaller files, or share large ones as a link.",
    );
  }
  return items.map(({ a, label, b64, size }) => {
    const given = typeof a.mime_type === "string" ? a.mime_type.trim() : "";
    if (given && !MIME_TYPE.test(given)) {
      throw new AttachmentError("invalid_attachment", `${label}: mime_type "${escapeDelimiters(given.slice(0, 80))}" isn't a type/subtype such as application/pdf (leave out parameters like "; charset").`);
    }
    if (/^(multipart|message)\//i.test(given)) {
      throw new AttachmentError("invalid_attachment", `${label}: ${given} can't be the type of an attached file; use application/octet-stream for a saved email.`);
    }
    const raw = typeof a.filename === "string" ? a.filename : "";
    // Without mime_type: from the extension, else application/octet-stream.
    const inferred = detectMimeType(sanitizeFilename(raw));
    // An inferred message/* or multipart/* type (x.eml, x.mht) would be embedded raw; attach those as plain bytes.
    const contentType = (given || (inferred && !/^(multipart|message)\//i.test(inferred) ? inferred : "") || "application/octet-stream").toLowerCase();
    const filename = sanitizeFilename(raw, contentType);
    // Still an encoded-word after the bounded unwrapping: a mail client would decode it once more, into a name
    // nothing here has checked. Refuse rather than send a name the approval card can't show.
    if (ENCODED_WORD.test(filename)) {
      throw new AttachmentError("invalid_attachment", `${label}: the filename is MIME-encoded (=?…?=); pass the plain file name.`);
    }
    const blocked = blockedExtension(filename);
    if (blocked) {
      throw new AttachmentError(
        "blocked_file_type",
        `${filename}: Gmail doesn't allow sending .${blocked} files (it blocks executables and similar types). Share it as a link instead.`,
      );
    }
    const content = Buffer.from(b64, "base64");
    if (!content.length || content.length !== size) {
      throw new AttachmentError("invalid_attachment", content.length ? `${label}: content_base64 is not valid base64.` : `${label} is empty: an attached file needs at least one byte.`);
    }
    return { filename, contentType, content };
  });
}

/** What the audit log and the approval card record about each file: name, type, size and sha256, never content. */
export function attachmentMeta(list: { filename: string; contentType?: string; content: Buffer }[], withHash = true): AttachmentMeta[] {
  return list.map((x) => ({
    filename: x.filename,
    mimeType: x.contentType ?? "application/octet-stream",
    size: x.content.length,
    ...(withHash ? { sha256: createHash("sha256").update(x.content).digest("hex") } : {}),
  }));
}
