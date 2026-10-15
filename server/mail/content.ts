// Content guardrails: clean, don't censor. Removes only what a human reader would never see
// (hidden HTML, invisible/smuggling unicode), converts HTML to markdown, and attaches informational
// signals. Content is never altered because of a signal.

import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { Address, ContentSignals, GmailLabel, MessageContent, MessageSummary } from "../../shared/types.ts";
import type { ParsedMessage } from "../google/types.ts";

// ───────────── Invisible unicode ─────────────

// Flagged and stripped: zero-width space/non-joiner/joiner (outside the contexts below), word joiner and
// invisible operators (U+2060–U+2064), BOM (except a leading one), bidi overrides LRO/RLO (U+202D/E) and
// tag characters (U+E0000–U+E007F, "ASCII smuggling").
// Stripped silently: bidi embeddings LRE/RLE, PDF (U+202A–U+202C) and isolates (U+2066–U+2069). They only
// change visual order, never the logical text an agent reads, and are common in legitimate RTL text.
// Kept: LRM/RLM (U+200E/F, never matched); ZWNJ/ZWJ between characters of joining scripts (Persian,
// Indic, …), where they change spelling; ZWJ inside emoji sequences; tag characters forming an emoji
// flag tag sequence (U+1F3F4 + tag letters/digits + CANCEL TAG).
const JOINING_SCRIPTS = [
  "Arabic", "Syriac", "Nko", "Mongolian", "Thaana", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya",
  "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Myanmar", "Khmer", "Tibetan",
].map((s) => `\\p{Script_Extensions=${s}}`).join("");
const PICTO = "\\p{Extended_Pictographic}";
const KEEP_FLAG = "\\u{1F3F4}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{2,7}\\u{E007F}";
const KEEP_JOINER = `(?<=[${JOINING_SCRIPTS}])[\\u200C\\u200D](?=[${JOINING_SCRIPTS}])`;
const KEEP_EMOJI_ZWJ = `(?<=${PICTO}(?:\\uFE0F|\\p{Emoji_Modifier})?)\\u200D(?=${PICTO})`;
const SILENT = "[\\u202A-\\u202C\\u2066-\\u2069]";
const FLAGGED = "[\\u200B-\\u200D\\u2060-\\u2064\\uFEFF\\u202D\\u202E\\u{E0000}-\\u{E007F}]";
const INVISIBLE = new RegExp(`(${KEEP_FLAG})|(${KEEP_JOINER})|(${KEEP_EMOJI_ZWJ})|(${SILENT})|${FLAGGED}`, "gu");

/** Removes invisible/smuggling characters. `removed` counts only the ones that can hide or disguise text. */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(INVISIBLE, (m: string, flag?: string, joiner?: string, zwj?: string, silent?: string, offset?: number) => {
    if (flag || joiner || zwj) return m;
    if (!silent && !(m === "\uFEFF" && offset === 0)) removed++;
    return "";
  });
  return { text: out, removed };
}

const visibleText = (s: string | null) => stripInvisible(s ?? "").text.trim();

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

/** Hidden in a way no descendant can undo: the element and its subtree are removed. */
function isRemovedByStyle(style: Map<string, string>): boolean {
  if (style.get("display") === "none") return true;
  if (isZeroLength(style.get("opacity"))) return true;
  // Collapsed boxes: max-height:0/height:0 with overflow hidden (a common "preheader" trick).
  const overflow = style.get("overflow");
  if (overflow === "hidden" && (isZeroLength(style.get("max-height")) || isZeroLength(style.get("height")))) return true;
  return false;
}

/** Effective zero font size. Relative sizes (em, %, ex, ch, smaller/larger, inherit) of a zero size stay zero. */
function fontSizeZero(value: string | undefined, parentZero: boolean): boolean {
  if (value === undefined) return parentZero;
  if (isZeroLength(value)) return true;
  if (/^(inherit|unset|smaller|larger)$/.test(value) || /^[\d.]+(em|%|ex|ch)$/.test(value)) return parentZero;
  return false;
}

/** A background a stylesheet or image could provide, so the inline background colour may not be what's shown. */
function hasBackgroundImage(style: Map<string, string>, el: DomElement): boolean {
  const bgImage = style.get("background-image");
  return (!!bgImage && bgImage !== "none") || /url\(/.test(style.get("background") ?? "") || el.hasAttribute("background");
}

const hasText = (n: DomNode) => visibleText(n.textContent).length > 0;

function isTrackingPixel(el: DomElement, style: Map<string, string>): boolean {
  const small = (v: string | null | undefined) => v != null && /^\s*[01](?:px)?\s*$/.test(v);
  return (small(el.getAttribute("width")) && small(el.getAttribute("height"))) || (small(style.get("width")) && small(style.get("height")));
}

/** Rendering context inherited down the tree (inline styles only; stylesheets are not evaluated). */
interface Inherited {
  color: string | null;
  bg: string | null;
  /** The real background may differ from `bg`: a background image, or a class/id a stylesheet could target. */
  bgUncertain: boolean;
  /** `background-clip: text` (gradient text): transparent text colour is still visible. */
  clipText: boolean;
  fontZero: boolean;
  /** visibility:hidden, which a descendant can undo with visibility:visible. */
  invisible: boolean;
}

interface CleanState {
  /** Hidden elements/text that carried readable text. */
  removed: number;
  /** The document had <style> blocks, so class/id selectors may change colours we can't see. */
  styled: boolean;
}

function textHidden(ctx: Inherited): boolean {
  if (ctx.invisible || ctx.fontZero) return true;
  if (ctx.color === "transparent") return !ctx.clipText;
  return !!ctx.color && !ctx.bgUncertain && ctx.color === ctx.bg;
}

function childContext(el: DomElement, style: Map<string, string>, parent: Inherited, state: CleanState): Inherited {
  const tag = el.tagName.toUpperCase();
  const visibility = style.get("visibility");
  const ownBg = backgroundColor(style, el);
  const targetable = state.styled && (el.hasAttribute("class") || el.hasAttribute("id"));
  const clip = style.get("background-clip") ?? style.get("-webkit-background-clip");
  return {
    color: normalizeColor(style.get("color")) ?? (tag === "FONT" ? normalizeColor(el.getAttribute("color")) : null) ?? parent.color,
    bg: ownBg ?? parent.bg,
    bgUncertain: (ownBg ? false : parent.bgUncertain) || hasBackgroundImage(style, el) || targetable,
    clipText: parent.clipText || clip === "text",
    fontZero: fontSizeZero(style.get("font-size"), parent.fontZero),
    invisible: visibility === "hidden" || visibility === "collapse" ? true : visibility === "visible" ? false : parent.invisible,
  };
}

function cleanTree(node: DomNode, ctx: Inherited, state: CleanState): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === COMMENT) {
      const text = (child.textContent ?? "").trim();
      // Outlook conditional comments are markup, not hidden prose.
      if (text && !/^\[if\b|^<!\[endif\]|^\[endif\]/i.test(text)) state.removed++;
      child.remove();
      continue;
    }
    if (child.nodeType === TEXT) {
      if (hasText(child) && textHidden(ctx)) {
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
    if (el.hasAttribute("hidden") || isRemovedByStyle(style)) {
      if (hasText(el)) state.removed++;
      el.remove();
      continue;
    }
    const inner = childContext(el, style, ctx, state);
    if (tag === "IMG") {
      // Images are never dropped for font-size; only when truly invisible or a tracking pixel.
      if (isTrackingPixel(el, style) || inner.invisible) el.remove();
      continue;
    }
    cleanTree(el, inner, state);
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

/**
 * Rebuilds a well-formed document (linkedom misplaces head content that isn't inside <head>): everything
 * before <body> goes into <head>, the rest (including stray content after </body>) into <body>.
 */
function normalizeDocument(html: string): string {
  const open = /<body\b([^>]*)>/i.exec(html);
  if (!open) return `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  const strip = (x: string) => x.replace(/<!DOCTYPE[^>]*>|<\/?(?:html|head|body)\b[^>]*>/gi, "");
  const head = strip(html.slice(0, open.index));
  const body = strip(html.slice(open.index + open[0].length));
  return `<!DOCTYPE html><html><head>${head}</head><body${open[1]}>${body}</body></html>`;
}

/** Cleans hidden content out of an HTML body and converts it to markdown. */
export function htmlToMarkdown(html: string): { markdown: string; removed: number } {
  const doc = parseHTML(normalizeDocument(html)).document as unknown as DomDocument;
  const root = doc.body ?? doc.documentElement;
  const state: CleanState = { removed: 0, styled: doc.documentElement.querySelector("style") !== null };
  const rootStyle = parseStyle(root.getAttribute("style"));
  if (root.hasAttribute("hidden") || isRemovedByStyle(rootStyle)) return { markdown: "", removed: hasText(root) ? 1 : 0 };
  const base: Inherited = { color: null, bg: null, bgUncertain: false, clipText: false, fontZero: false, invisible: false };
  const rootCtx = childContext(root, rootStyle, base, state);
  if (!rootCtx.color) rootCtx.color = normalizeColor(root.getAttribute("text"));
  cleanTree(root, rootCtx, state);
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

/**
 * SPF/DKIM/DMARC from the topmost Authentication-Results header only, which Gmail adds on receipt
 * (authserv-id mx.google.com). Lower headers can be supplied by the sender and never fill gaps. Comments
 * and quoted strings are removed first, and results are read only at the start of each resinfo.
 */
export function parseAuthResults(header: string | null): ContentSignals["auth"] {
  if (!header) return null;
  // Unfold continuation lines, then take the first header (several are joined with "\n").
  const top = header.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)[0] ?? "";
  let s = top.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, " ");
  }
  const [servId = "", ...resinfo] = s.split(";");
  if (!/^(?:[a-z0-9-]+\.)*google\.com$/i.test(servId.trim().split(/\s+/)[0] ?? "")) return null;
  const result = (method: string) => {
    for (const r of resinfo) {
      const m = new RegExp(`^\\s*${method}\\s*=\\s*([a-z]+)`, "i").exec(r);
      if (m) return m[1]!.toLowerCase();
    }
    return null;
  };
  return { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") };
}

/** Consumer mailbox domains: senders on the same domain are still other people. */
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Lower-cased address; Gmail addresses ignore dots and +tags in the local part, googlemail.com ≡ gmail.com. */
function canonicalAddress(email: string): { local: string; domain: string } {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (CONSUMER_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = local.replace(/\+.*$/, "").replace(/\./g, "");
  }
  return { local, domain };
}

/** Sender outside the account's organization (subdomains count as inside); for consumer Gmail, anyone but the account itself. */
export function isExternal(sender: string | null | undefined, accountEmail: string): boolean {
  if (!sender) return false;
  const s = canonicalAddress(sender);
  const own = canonicalAddress(accountEmail);
  if (own.domain === "gmail.com") return s.local !== own.local || s.domain !== own.domain;
  return !(s.domain === own.domain || s.domain.endsWith(`.${own.domain}`));
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

/** Neutralizes our delimiter tags inside untrusted text. */
export const escapeDelimiters = (s: string) => s.replace(/<(\/?)(email_content)/gi, "&lt;$1$2");

/** Wraps untrusted content in the delimiter. Literal delimiter tags inside the content are escaped. */
export function wrapUntrusted(from: string | null | undefined, body: string): string {
  return `<email_content from="${escapeAttr(from ?? "unknown")}" untrusted>\n${escapeDelimiters(body)}\n</email_content>`;
}

/** Untrusted header-ish text (subjects, names, snippets) on one line: cleaned, delimiter-escaped, optionally clipped. */
export function cleanLine(s: string, max = 0): string {
  const one = escapeDelimiters(stripInvisible(s).text.replace(/\s+/g, " ").trim());
  return max && one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function formatAddress(a: Address | null | undefined): string {
  if (!a) return "(unknown)";
  const name = a.name ? cleanLine(a.name, 100) : "";
  if (!name || name.toLowerCase() === a.email.toLowerCase()) return a.email;
  // A display name that looks like an address ("<ceo@acme.com>") must not read as the real sender.
  return /[<>@"]/.test(name) ? `"${name.replace(/[<>"]/g, "")}" <${a.email}>` : `${name} <${a.email}>`;
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
  lines.push(`Date: ${summary.date}`, `Subject: ${cleanLine(summary.subject) || "(no subject)"}`);
  if (summary.labelIds.length) lines.push(`Labels: ${labelNames(summary.labelIds, labels).join(", ")}`);
  if (content.attachments.length) {
    lines.push(
      `Attachments: ${content.attachments
        .map((a) => `${cleanLine(a.filename) || "(unnamed)"} (${a.mimeType}, ${formatSize(a.size)}, attachment_id: ${a.id})`)
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
