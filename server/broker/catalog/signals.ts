// Informational signals on a tool definition, shown on the connection page. They never block anything.

import type { ToolDef } from "../types.ts";
import type { CleanStats } from "./clean.ts";

export type ToolSignalKind =
  | "important_tag"
  | "concealment"
  | "file_path"
  | "cross_reference"
  | "catch_all_param"
  | "base64_blob"
  | "hidden_characters"
  | "truncated"
  /** The tool wasn't stored or served: its definition is too deep, too large or not JSON, or its name can't be used. */
  | "refused";

export interface ToolSignal {
  kind: ToolSignalKind;
  /** Short, cleaned evidence (a param name, a path, another tool's name). Never the whole description. */
  detail?: string;
}

const IMPORTANT = /<\s*\/?\s*(important|system|instructions?|secret)\b[^>]{0,40}>/i;
const CONCEALMENT =
  /\b(?:do\s*n[o']?t|never|without)\s+(?:tell(?:ing)?|inform(?:ing)?|mention(?:ing)?|notify(?:ing)?|show(?:ing)?|alert(?:ing)?)\s+(?:this\s+(?:to\s+)?)?(?:the\s+)?user\b|\bhide\s+(?:this|it)\s+from\s+(?:the\s+)?user\b/i;
const PATHS =
  /(?:~\/|\$HOME\/)[\w./-]+|\.ssh\b|\bid_(?:rsa|ed25519|ecdsa)\b|\bmcp\.json\b|claude_desktop_config|\.aws\/credentials|\.npmrc\b|\.netrc\b|\.env\b|\/etc\/(?:passwd|shadow)|\.cursor\/|\.codex\/|\.hermes\/|\.agentinbox\b|master\.key\b/i;
const BASE64 = /[A-Za-z0-9+/]{80,}={0,2}|[A-Za-z0-9_-]{120,}/;
/** Parameter names that invite the model to put conversation context in (the "sidenote" exfiltration pattern). */
export const CATCH_ALL_PARAMS: ReadonlySet<string> = new Set(["context", "sidenote", "side_note", "notes", "note", "extra", "conversation", "history"]);

/** Above the cleaning depth limit (CLEAN_LIMITS.schemaDepth), so a cleaned schema is always walked in full. */
const SIGNAL_DEPTH = 64;

export interface SignalContext {
  /** Slugs of the other connections. */
  otherSlugs: readonly string[];
  /** Names another server's tools are known by: other connections' tool and exposed names, native tool names. */
  otherToolNames: readonly string[];
}

/** Every string of a (cleaned, depth-bounded) schema: keys and values. Stops at the limit instead of recursing. */
function schemaTexts(node: unknown, out: string[], depth = 0): void {
  if (depth > SIGNAL_DEPTH || out.length > 10_000) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const v of node) schemaTexts(v, out, depth + 1);
    return;
  }
  for (const k of Object.keys(node)) {
    out.push(k);
    schemaTexts((node as Record<string, unknown>)[k], out, depth + 1);
  }
}

function paramNames(schema: unknown, out: string[], depth = 0): void {
  if (depth > SIGNAL_DEPTH || !schema || typeof schema !== "object") return;
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return;
  for (const k of Object.keys(props)) {
    out.push(k);
    paramNames((props as Record<string, unknown>)[k], out, depth + 1);
  }
}

const clip = (s: string) => (s.length > 64 ? `${s.slice(0, 63)}…` : s);

/** Signals for one cleaned definition (with the stats from cleaning it). */
export function toolSignals(def: ToolDef, stats: CleanStats, ctx: SignalContext): ToolSignal[] {
  const texts = [def.description, def.title ?? "", def.annotations?.title ?? ""];
  schemaTexts(def.inputSchema, texts);
  schemaTexts(def.outputSchema, texts);
  const text = texts.filter(Boolean).join("\n");
  const out: ToolSignal[] = [];
  const add = (kind: ToolSignalKind, detail?: string) => {
    if (!out.some((s) => s.kind === kind && s.detail === detail)) out.push(detail === undefined ? { kind } : { kind, detail: clip(detail) });
  };

  const imp = IMPORTANT.exec(text);
  if (imp) add("important_tag", imp[0]);
  const con = CONCEALMENT.exec(text);
  if (con) add("concealment", con[0]);
  const path = PATHS.exec(text);
  if (path) add("file_path", path[0]);
  if (BASE64.test(text)) add("base64_blob");

  // Other servers: a slug used as a prefix or word, or another tool's name (only distinctive ones: ≥ 6 chars or
  // with a separator, so "get" or "search" don't fire on every description).
  const tokens = new Set((text.match(/[A-Za-z0-9_-]+/g) ?? []).map((t) => t.toLowerCase()));
  for (const slug of ctx.otherSlugs) {
    const s = slug.toLowerCase();
    if (s && [...tokens].some((t) => t === s || t.startsWith(`${s}__`))) add("cross_reference", slug);
  }
  for (const name of ctx.otherToolNames) {
    if (name === def.name || (name.length < 6 && !/[_-]/.test(name))) continue;
    if (tokens.has(name.toLowerCase())) add("cross_reference", name);
    if (out.length > 32) break;
  }

  const params: string[] = [];
  paramNames(def.inputSchema, params);
  for (const p of params) if (CATCH_ALL_PARAMS.has(p.toLowerCase())) add("catch_all_param", p);

  if (stats.removed > 0) add("hidden_characters", String(stats.removed));
  if (stats.truncated > 0) add("truncated", String(stats.truncated));
  return out;
}
