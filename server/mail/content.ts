// Content guardrails: clean, don't censor. Removes only what a human reader would never see
// (hidden HTML, invisible/smuggling unicode), converts HTML to markdown, and attaches informational
// signals. Content is never altered because of a signal.

import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { Address, ContentSignals, GmailLabel, MessageContent, MessageSummary } from "../../shared/types.ts";
import type { ParsedMessage } from "../google/types.ts";

// ───────────── Invisible unicode ─────────────

// Zero-width (U+200B–U+200D), word joiner + invisible operators (U+2060–U+2064), BOM (U+FEFF),
// bidi embeddings/overrides (U+202A–U+202E) and isolates (U+2066–U+2069), tag characters (U+E0000–U+E007F).
const INVISIBLE = /[\u200B-\u200D\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;
// A ZWJ inside an emoji sequence (👨\u200D👩\u200D👧) is visible as part of the glyph: keep it.
const EMOJI_ZWJ = /(\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
const ZWJ_KEEP = "\u0000ZWJ\u0000";

/** Removes invisible/smuggling characters. Returns the cleaned text and how many were removed. */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text
    .replace(EMOJI_ZWJ, `$1${ZWJ_KEEP}`)
    .replace(INVISIBLE, () => {
      removed++;
      return "";
    })
    .replaceAll(ZWJ_KEEP, "\u200D");
  return { text: out, removed };
}

// ───────────── Minimal DOM typing (linkedom; the server tsconfig has no DOM lib) ─────────────

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  parentNode: DomNode | null;
  remove(): void;
}

interface DomElement extends DomNode {
  tagName: string;
  innerHTML: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(sel: string): DomElement | null;
  querySelectorAll(sel: string): ArrayLike<DomElement>;
  replaceWith(...nodes: (DomNode | string)[]): void;
  append(...nodes: (DomNode | string)[]): void;
  closest(sel: string): DomElement | null;
}

interface DomDocument {
  body: DomElement | null;
  documentElement: DomElement;
  createElement(tag: string): DomElement;
  createTextNode(text: string): DomNode;
}

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;

// ───────────── CSS helpers ─────────────

function parseStyle(style: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!style) return out;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl
      .slice(i + 1)
      .replace(/!important/i, "")
      .trim()
      .toLowerCase();
    if (prop && value) out.set(prop, value);
  }
  return out;
}

const isZeroLength = (v: string | undefined) => v !== undefined && /^[-+]?0*\.?0+(?:[a-z%]+)?$/.test(v.trim());

const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  navy: "#000080",
  maroon: "#800000",
  orange: "#ffa500",
  purple: "#800080",
  whitesmoke: "#f5f5f5",
  snow: "#fffafa",
  ivory: "#fffff0",
};

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** Normalizes a CSS colour to "#rrggbb", "transparent", or null when unknown. */
export function normalizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return "transparent";
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) {
    const [r, g, b, a] = m[1]!.split("");
    if (a === "0") return "transparent";
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return m[2] === "00" ? "transparent" : `#${m[1]}`;
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const ch = (s: string) => (s.endsWith("%") ? (parseFloat(s) * 255) / 100 : parseFloat(s));
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return "transparent";
    return `#${hex2(ch(m[1]!))}${hex2(ch(m[2]!))}${hex2(ch(m[3]!))}`;
  }
  return null;
}

/** First colour token of a `background` shorthand. */
function backgroundColor(style: Map<string, string>, el: DomElement): string | null {
  const direct = normalizeColor(style.get("background-color"));
  if (direct) return direct;
  const shorthand = style.get("background");
  if (shorthand) {
    for (const token of shorthand.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|[a-z]+/g) ?? []) {
      const c = normalizeColor(token);
      if (c) return c;
    }
  }
  return normalizeColor(el.getAttribute("bgcolor"));
}

// ───────────── HTML cleaning ─────────────

/** Structural elements that never render as readable text. Removed silently (not "hidden content"). */
const NON_RENDERED = new Set(["SCRIPT", "STYLE", "HEAD", "TITLE", "META", "LINK", "TEMPLATE", "NOSCRIPT", "OBJECT", "EMBED", "IFRAME", "SVG"]);

function isHiddenByStyle(style: Map<string, string>): boolean {
  if (style.get("display") === "none") return true;
  const visibility = style.get("visibility");
  if (visibility === "hidden" || visibility === "collapse") return true;
  if (isZeroLength(style.get("opacity"))) return true;
  if (isZeroLength(style.get("font-size"))) return true;
  // Collapsed boxes: max-height:0/height:0 with overflow hidden (a common "preheader" trick).
  const overflow = style.get("overflow");
  if (overflow === "hidden" && (isZeroLength(style.get("max-height")) || isZeroLength(style.get("height")))) return true;
  return false;
}

const hasText = (n: DomNode) => (n.textContent ?? "").replace(INVISIBLE, "").trim().length > 0;

function isTrackingPixel(el: DomElement, style: Map<string, string>): boolean {
  const small = (v: string | null | undefined) => v != null && /^\s*[01](?:px)?\s*$/.test(v);
  return (small(el.getAttribute("width")) && small(el.getAttribute("height"))) || (small(style.get("width")) && small(style.get("height")));
}

interface CleanState {
  /** Hidden elements/text that carried readable text. */
  removed: number;
}

function cleanTree(node: DomNode, color: string | null, bg: string | null, state: CleanState): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === COMMENT) {
      const text = (child.textContent ?? "").trim();
      // Outlook conditional comments are markup, not hidden prose.
      if (text && !/^\[if\b|^<!\[endif\]|^\[endif\]/i.test(text)) state.removed++;
      child.remove();
      continue;
    }
    if (child.nodeType === TEXT) {
      if (color && hasText(child) && (color === "transparent" || color === bg)) {
        state.removed++;
        child.remove();
      }
      continue;
    }
    if (child.nodeType !== ELEMENT) continue;
    const el = child as DomElement;
    const tag = el.tagName.toUpperCase();
    if (NON_RENDERED.has(tag)) {
      el.remove();
      continue;
    }
    const style = parseStyle(el.getAttribute("style"));
    if (el.hasAttribute("hidden") || isHiddenByStyle(style)) {
      if (hasText(el)) state.removed++;
      el.remove();
      continue;
    }
    if (tag === "IMG" && isTrackingPixel(el, style)) {
      el.remove();
      continue;
    }
    const ownColor = normalizeColor(style.get("color")) ?? (tag === "FONT" ? normalizeColor(el.getAttribute("color")) : null);
    cleanTree(el, ownColor ?? color, backgroundColor(style, el) ?? bg, state);
  }
}

// ───────────── HTML → markdown ─────────────

const BLOCK_IN_CELL = "div,p,table,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,pre,hr";

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  td.use(gfm);
  td.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as unknown as DomElement;
      const alt = (el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
      const src = (el.getAttribute("src") ?? "").trim();
      if (!src || /^(data|cid|javascript):/i.test(src)) return alt ? `[image: ${alt}]` : "";
      return `![${alt.replace(/[[\]]/g, "")}](${src.replace(/[()\s]/g, encodeURIComponent)})`;
    },
  });
  td.addRule("unsafeLinks", {
    filter: (node) => {
      if (node.nodeName !== "A") return false;
      const href = ((node as unknown as DomElement).getAttribute("href") ?? "").trim();
      return !href || /^(javascript|data|vbscript):/i.test(href);
    },
    replacement: (content) => content,
  });
  return td;
}

let turndownInstance: TurndownService | undefined;
const turndown = () => (turndownInstance ??= createTurndown());

/** A table holding data (rendered as a GFM table) rather than email layout (unwrapped into blocks). */
function isDataTable(table: DomElement): boolean {
  const role = (table.getAttribute("role") ?? "").toLowerCase();
  if (role === "presentation" || role === "none") return false;
  if (table.querySelector("table")) return false;
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length < 2) return false;
  const widths = rows.map((r) => cellsOf(r).length);
  if (Math.max(...widths) < 2) return false;
  if (table.querySelector("th")) return true;
  return !table.querySelector(BLOCK_IN_CELL);
}

const cellsOf = (row: DomElement) => Array.from(row.childNodes).filter((n): n is DomElement => n.nodeName === "TD" || n.nodeName === "TH");

function tableToMarkdown(table: DomElement): string {
  const rows = Array.from(table.querySelectorAll("tr")).map((r) =>
    cellsOf(r).map((c) =>
      turndown()
        .turndown(c.innerHTML)
        .replace(/\s*\n+\s*/g, " ")
        .replace(/\|/g, "\\|")
        .trim(),
    ),
  );
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

/** Converts tables in place: data tables become placeholders (filled after turndown), layout tables become blocks. */
function prepareTables(doc: DomDocument, root: DomElement): Map<string, string> {
  const placeholders = new Map<string, string>();
  const tables = Array.from(root.querySelectorAll("table"));
  const data = new Set(tables.filter(isDataTable));
  for (const table of data) {
    const key = `AIBTABLE${placeholders.size}X`;
    placeholders.set(key, tableToMarkdown(table));
    const p = doc.createElement("p");
    p.append(key);
    table.replaceWith(p);
  }
  for (const el of Array.from(root.querySelectorAll("table,thead,tbody,tfoot,tr,td,th,caption"))) {
    const div = doc.createElement("div");
    div.append(...Array.from(el.childNodes));
    el.replaceWith(div);
  }
  return placeholders;
}

function tidyMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cleans hidden content out of an HTML body and converts it to markdown. */
export function htmlToMarkdown(html: string): { markdown: string; removed: number } {
  const source = /<html[\s>]/i.test(html) ? html : `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  const doc = parseHTML(source).document as unknown as DomDocument;
  const root = doc.body ?? doc.documentElement;
  const state: CleanState = { removed: 0 };
  // Body-level colours count as the starting context.
  const bodyStyle = parseStyle(root.getAttribute("style"));
  const bodyColor = normalizeColor(bodyStyle.get("color")) ?? normalizeColor(root.getAttribute("text"));
  if (root.hasAttribute("hidden") || isHiddenByStyle(bodyStyle)) {
    return { markdown: "", removed: hasText(root) ? 1 : 0 };
  }
  cleanTree(root, bodyColor, backgroundColor(bodyStyle, root), state);
  const tables = prepareTables(doc, root);
  let md = turndown().turndown(root.innerHTML);
  for (const [key, table] of tables) md = md.replace(key, `\n\n${table}\n\n`);
  const stripped = stripInvisible(md);
  return { markdown: tidyMarkdown(stripped.text), removed: state.removed + stripped.removed };
}

/** Cleans a text/plain body. */
export function cleanPlainText(text: string): { text: string; removed: number } {
  const stripped = stripInvisible(text);
  return { text: tidyMarkdown(stripped.text), removed: stripped.removed };
}

// ───────────── Signals ─────────────

/** First spf/dkim/dmarc result in Authentication-Results (the topmost header is the receiving server's). */
export function parseAuthResults(header: string | null): ContentSignals["auth"] {
  if (!header) return null;
  const first = (mech: string) => new RegExp(`\\b${mech}\\s*=\\s*([a-z]+)`, "i").exec(header)?.[1]?.toLowerCase() ?? null;
  return { spf: first("spf"), dkim: first("dkim"), dmarc: first("dmarc") };
}

/** Consumer mailbox domains: senders on the same domain are still other people. */
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function isExternal(sender: string | null | undefined, accountEmail: string): boolean {
  if (!sender) return false;
  const s = sender.trim().toLowerCase();
  const own = accountEmail.trim().toLowerCase();
  const domain = (e: string) => e.slice(e.lastIndexOf("@") + 1);
  if (CONSUMER_DOMAINS.has(domain(own))) return s !== own;
  return domain(s) !== domain(own);
}

const SUSPICIOUS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|existing)\s+(?:instructions?|prompts?|directions|rules|guidelines|messages)\b/i,
  /\byou\s+are\s+now\s+(?:an?\s+(?:ai|assistant|agent|new|different)\b|acting\s+as\b|in\s+(?:developer|god|admin|debug|dan)\s+mode\b|dan\b)/i,
  /\bsystem\s+prompt\b/i,
  /\bnew\s+instructions\s*:/i,
  /\bforward\s+(?:all|every|each)\s+(?:of\s+(?:the|your|my)\s+)?(?:e-?mails?|messages|mail|correspondence)\b/i,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|alert|mention\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|owner|human|recipient)\b/i,
  /\bBEGIN\s+SYSTEM\b|\bEND\s+SYSTEM\b|<\/?system>|\[\/?system\]|<\|im_start\|>/i,
  /^\s*(?:assistant|system)\s*:/im,
  /\b(?:reveal|send|share|leak|exfiltrate)\s+(?:me\s+)?(?:your|the)\s+(?:api\s+keys?|credentials|passwords?|secrets?|tokens?|instructions)\b/i,
  /\b(?:delete|trash)\s+(?:all|every)\s+(?:e-?mails?|messages)\b/i,
  /\bnote\s+to\s+(?:the\s+)?(?:ai|assistant|agent|llm)\b/i,
];

/** Phrases common in prompt-injection attempts. Informational only. */
export function suspiciousPhrases(text: string): string[] {
  const hits = new Set<string>();
  for (const re of SUSPICIOUS) {
    const m = re.exec(text);
    if (m) hits.add(m[0].replace(/\s+/g, " ").trim());
  }
  return [...hits].slice(0, 5);
}

// ───────────── Truncation ─────────────

/** Truncates to `max` chars (0 = unlimited) at a paragraph, line or word boundary when one is close. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (!max || text.length <= max) return { text, truncated: false };
  let cut = max;
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? "")) cut--;
  const window = text.slice(0, cut);
  const floor = Math.floor(cut * 0.8);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = window.lastIndexOf(sep);
    if (i >= floor) return { text: window.slice(0, i).trimEnd(), truncated: true };
  }
  return { text: window, truncated: true };
}

// ───────────── Message content ─────────────

export interface BuiltContent extends MessageContent {
  /** Untruncated length, for the "truncated" note. */
  totalChars: number;
}

/** Cleaned, markdown-converted content with signals. Prefers HTML (more faithful), else text/plain. */
export function buildContent(parsed: ParsedMessage, opts: { accountEmail: string; maxChars: number }): BuiltContent {
  let body = "";
  let removed = 0;
  if (parsed.html && parsed.html.trim()) {
    const r = htmlToMarkdown(parsed.html);
    body = r.markdown;
    removed = r.removed;
  }
  if (!body && parsed.text) {
    const r = cleanPlainText(parsed.text);
    body = r.text;
    removed += r.removed;
  }
  const subject = stripInvisible(parsed.summary.subject ?? "");
  removed += subject.removed;
  const t = truncateText(body, opts.maxChars);
  return {
    body: t.text,
    truncated: t.truncated,
    totalChars: body.length,
    attachments: parsed.attachments,
    signals: {
      hiddenContentRemoved: removed > 0,
      suspiciousInstructions: suspiciousPhrases(`${subject.text}\n${body}`),
      auth: parseAuthResults(parsed.authenticationResults),
      external: isExternal(parsed.summary.from?.email, opts.accountEmail),
    },
  };
}

// ───────────── Rendering for agents ─────────────

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Wraps untrusted content in the delimiter. Literal delimiter tags inside the content are escaped. */
export function wrapUntrusted(from: string | null | undefined, body: string): string {
  const safe = body.replace(/<(\/?)(email_content)/gi, "&lt;$1$2");
  return `<email_content from="${escapeAttr(from ?? "unknown")}" untrusted>\n${safe}\n</email_content>`;
}

const oneLine = (s: string) => stripInvisible(s).text.replace(/\s+/g, " ").trim();

export function formatAddress(a: Address | null | undefined): string {
  if (!a) return "(unknown)";
  const name = a.name ? oneLine(a.name) : "";
  return name && name.toLowerCase() !== a.email.toLowerCase() ? `${name} <${a.email}>` : a.email;
}

export const formatAddresses = (list: Address[]) => list.map(formatAddress).join(", ");

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function labelNames(ids: string[], labels: GmailLabel[] | null): string[] {
  const byId = new Map((labels ?? []).map((l) => [l.id, l.name]));
  return ids.map((id) => byId.get(id) ?? id);
}

/** Only noteworthy signals, on one short line; null when there is nothing to say. */
export function signalLine(s: ContentSignals): string | null {
  const parts: string[] = [];
  if (s.auth) {
    const failed = (["spf", "dkim", "dmarc"] as const).filter((k) => {
      const v = s.auth![k];
      return v !== null && !["pass", "none", "neutral", "bestguesspass"].includes(v);
    });
    if (failed.length) parts.push(`sender authentication failed (${failed.map((k) => `${k.toUpperCase()}=${s.auth![k]}`).join(", ")})`);
  }
  if (s.external) parts.push("external sender");
  if (s.hiddenContentRemoved) parts.push("hidden content removed");
  if (s.suspiciousInstructions.length) {
    parts.push(`contains instruction-like text (${s.suspiciousInstructions.map((p) => `"${p.slice(0, 60)}"`).join(", ")})`);
  }
  return parts.length ? `Signals: ${parts.join("; ")}` : null;
}

/** Compact header block + one wrapped body. */
export function renderMessage(summary: MessageSummary, content: BuiltContent, labels: GmailLabel[] | null, maxChars: number): string {
  const lines = [`Message ${summary.id} (thread ${summary.threadId})`, `From: ${formatAddress(summary.from)}`];
  if (summary.to.length) lines.push(`To: ${formatAddresses(summary.to)}`);
  if (summary.cc.length) lines.push(`Cc: ${formatAddresses(summary.cc)}`);
  lines.push(`Date: ${summary.date}`, `Subject: ${oneLine(summary.subject) || "(no subject)"}`);
  if (summary.labelIds.length) lines.push(`Labels: ${labelNames(summary.labelIds, labels).join(", ")}`);
  if (content.attachments.length) {
    lines.push(
      `Attachments: ${content.attachments
        .map((a) => `${oneLine(a.filename) || "(unnamed)"} (${a.mimeType}, ${formatSize(a.size)}, attachment_id: ${a.id})`)
        .join("; ")}`,
    );
  }
  const signals = signalLine(content.signals);
  if (signals) lines.push(signals);
  lines.push(wrapUntrusted(summary.from?.email, content.body || "(empty body)"));
  if (content.truncated) {
    lines.push(`[Body truncated at ${maxChars} of ${content.totalChars} characters (operator setting maxBodyChars).]`);
  }
  return lines.join("\n");
}
