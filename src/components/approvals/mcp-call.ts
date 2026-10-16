// The `mcp.call` approval card's text as pure functions (docs/MCP-BROKER.md, "Exact arguments"): the stored argument
// bytes pretty-printed without re-serialising any value, invisible characters turned into visible JSON escapes, and
// the recipients and URLs pulled out to show first. Relative imports only: vitest loads this module too.

import type { ApprovalStatus, BrokerApproval, McpCallDetail } from "../../lib/broker-dto.ts";

/**
 * Characters a reviewer can't see (the console's hidden-chars set: zero-width, bidi controls, invisible operators,
 * BOM, soft hyphen, tag characters, variation selectors) plus C1 controls, NBSP-like spaces and lone surrogates.
 * In JSON they're escaped as \uXXXX, which is the same string to any JSON parser.
 */
// oxlint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u0080-\u00A0\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

const esc = (unit: number) => `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;

/** Replaces every invisible character in `s` with its JSON escape (astral ones as a surrogate pair). */
export function escapeInvisible(s: string): string {
  return s.replace(new RegExp(INVISIBLE.source, "gu"), (ch) => {
    let out = "";
    for (let i = 0; i < ch.length; i++) out += esc(ch.charCodeAt(i));
    return out;
  });
}

export function hasInvisible(s: string): boolean {
  return new RegExp(INVISIBLE.source, "u").test(s);
}

/** Whether stored JSON arguments carry invisible characters, raw or written as \u escapes. */
export function argsHaveInvisible(raw: string): boolean {
  if (hasInvisible(raw)) return true;
  try {
    return hasInvisible(JSON.stringify(JSON.parse(raw)));
  } catch {
    return false;
  }
}

/**
 * Indents JSON text token by token, never parsing values: numbers, strings and their escapes stay byte-for-byte
 * what was stored (a JSON.parse round trip would round big integers and normalise escapes). Invisible characters
 * inside strings become escapes. Text that isn't valid JSON is returned escaped but otherwise unchanged.
 */
export function prettyJson(raw: string, indent = "  "): string {
  try {
    JSON.parse(raw);
  } catch {
    return escapeInvisible(raw);
  }
  let out = "";
  let depth = 0;
  let inString = false;
  let i = 0;
  const nl = () => "\n" + indent.repeat(depth);
  while (i < raw.length) {
    const ch = raw[i]!;
    if (inString) {
      if (ch === "\\") {
        out += raw.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "{" || ch === "[") {
      // Empty containers stay on one line.
      let k = i + 1;
      while (k < raw.length && /\s/.test(raw[k]!)) k++;
      const close = ch === "{" ? "}" : "]";
      if (raw[k] === close) {
        out += ch + close;
        i = k + 1;
        continue;
      }
      depth++;
      out += ch + nl();
    } else if (ch === "}" || ch === "]") {
      depth--;
      out += nl() + ch;
    } else if (ch === ",") out += "," + nl();
    else if (ch === ":") out += ": ";
    else if (!/\s/.test(ch)) out += ch;
    i++;
  }
  return escapeInvisible(out);
}

export interface ArgHighlight {
  /** Dot path of the argument, e.g. "to.0" or "parent.page_id". */
  path: string;
  kind: "recipient" | "url";
  value: string;
}

const EMAIL_RE = /[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+\.[^\s<>"',;:()[\]]+/g;
const URL_RE = /\b(?:https?|ftp|wss?):\/\/[^\s<>"']+/gi;

/** Email addresses and URLs anywhere in the arguments, in order, each once: what the card lists first. */
export function argHighlights(raw: string, max = 20): ArgHighlight[] {
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: ArgHighlight[] = [];
  const seen = new Set<string>();
  const add = (path: string, kind: ArgHighlight["kind"], value: string) => {
    const key = `${kind}:${value}`;
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ path, kind, value });
  };
  const walk = (v: unknown, path: string) => {
    if (out.length >= max) return;
    if (typeof v === "string") {
      // URLs first, so an address inside a URL (user@host) isn't listed as a recipient too.
      const urls = v.match(URL_RE) ?? [];
      for (const u of urls) add(path, "url", u);
      const rest = urls.reduce((s, u) => s.replace(u, " "), v);
      for (const e of rest.match(EMAIL_RE) ?? []) add(path, "recipient", e);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(args, "");
  return out;
}

/** An approvals-list item as an mcp.call approval, or null (mail and calendar kinds). */
export function asMcpApproval(a: { kind: string }): (BrokerApproval & { kind: "mcp.call"; mcp: McpCallDetail }) | null {
  const b = a as BrokerApproval;
  return b.kind === "mcp.call" && b.mcp ? (b as BrokerApproval & { kind: "mcp.call"; mcp: McpCallDetail }) : null;
}

/** "notion-delete-pages on Notion". */
export const callTitle = (m: Pick<McpCallDetail, "tool" | "connectionName">) => `${m.tool} on ${m.connectionName}`;

/** The "only for …" checkbox label, when the API gave a target. */
export function targetLabel(t: NonNullable<McpCallDetail["target"]>): string {
  const v = t.value.length > 60 ? `${t.value.slice(0, 57)}…` : t.value;
  return `Only for ${t.label ?? t.path} ${escapeInvisible(v)}`;
}

export type McpDecision = "approve" | "always" | "reject";

/** The one-tap page's done state after a decision (or when it was already decided). */
export function doneState(status: ApprovalStatus, decision: McpDecision | null): { title: string; description: string; tone: "good" | "bad" | "idle" } {
  switch (status) {
    case "sent":
    case "approved":
      return {
        title: decision === "always" ? "Approved, and always allowed" : "Approved",
        description:
          (status === "sent" ? "The call ran. " : "The call is running. ") +
          (decision === "always" ? "Matching calls from this agent won't ask again. You can remove the rule on the agent's page." : "The agent gets the result when it checks back."),
        tone: "good",
      };
    case "failed":
      return { title: "Approved, but the call failed", description: "The agent is told it failed. Nothing is retried automatically.", tone: "bad" };
    case "rejected":
      return { title: "Rejected", description: "Nothing ran. The agent is told you rejected it.", tone: "idle" };
    case "expired":
      return { title: "This request expired", description: "Nothing ran. The agent can ask again.", tone: "idle" };
    case "pending":
      return { title: "Waiting for you", description: "", tone: "idle" };
  }
}
