/**
 * A small reader for the `mcp_servers:` block of a Hermes config.yaml, without a YAML library (like
 * server/listen/mcpsetup.ts). It handles the block style Hermes writes and documents: nested maps, plain and
 * quoted scalars, flow sequences of scalars (`args: ["-y", "pkg"]`) and block sequences of scalars. Anything else
 * (anchors, block scalars, flow maps, tabs) becomes UNREADABLE for that value, so the caller can skip the entry
 * that uses it instead of guessing. Only the mcp_servers block is read: the rest of the file never matters.
 */

export const UNREADABLE = Symbol("unreadable");
export type YamlValue = string | number | boolean | null | typeof UNREADABLE | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

/** The text of a line without a trailing comment (a `#` after whitespace, outside quotes). */
export function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s:[{,-]/.test(line[i - 1]!)) quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

/** The line range of the top-level `mcp_servers:` block, or null when there isn't exactly one. */
export function mcpServersBlock(yaml: string): { start: number; end: number; inline: string } | null {
  return topBlock(yaml, "mcp_servers");
}

const keyRe = (key: string) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);

/** The line range of a top-level `<key>:` block, or null when there isn't exactly one. */
export function topBlock(yaml: string, key: string): { start: number; end: number; inline: string } | null {
  const re = keyRe(key);
  const lines = yaml.replace(/^﻿/, "").split("\n");
  const tops = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
  if (tops.length !== 1) return null;
  const start = tops[0]!;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!) || lines[end]!.startsWith("#"))) end++;
  // Trailing blank lines and column-0 comments belong to whatever comes next.
  while (end > start + 1 && (lines[end - 1]!.trim() === "" || lines[end - 1]!.startsWith("#"))) end--;
  return { start, end, inline: stripComment(lines[start]!.replace(re, "")).trim() };
}

function unquote(raw: string): string | typeof UNREADABLE {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) return UNREADABLE;
    try {
      // YAML double-quoted escapes are a superset of JSON's; the common ones agree.
      return JSON.parse(raw.replace(/\\\//g, "/")) as string;
    } catch {
      return UNREADABLE;
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) return UNREADABLE;
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

/** Splits a flow sequence body on top-level commas. */
function splitFlow(body: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') cur += body[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "[" || ch === "{" || ch === "]" || ch === "}") return null;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (quote) return null;
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function scalar(raw: string): YamlValue {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null" || v === "Null" || v === "NULL") return null;
  if (/^[&*!|>]/.test(v) || v.startsWith("<<") || v.startsWith("{")) return UNREADABLE;
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) return UNREADABLE;
    const items = splitFlow(v.slice(1, -1));
    return items ? items.map((i) => scalar(i)) : UNREADABLE;
  }
  if (v.startsWith('"') || v.startsWith("'")) return unquote(v);
  if (/^(true|True|TRUE)$/.test(v)) return true;
  if (/^(false|False|FALSE)$/.test(v)) return false;
  if (/^[-+]?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** `key: rest` with a plain or quoted key; null when the line isn't one. */
function keyValue(text: string): { key: string; rest: string } | null {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^"'#:\s][^:]*?)\s*:(?:\s+(.*)|$)/.exec(text);
  if (!m) return null;
  const key = unquote(m[1]!);
  if (key === UNREADABLE) return null;
  return { key, rest: (m[2] ?? "").trim() };
}

function parseLines(lines: Line[], from: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[from];
  if (!first || first.indent < indent) return { value: null, next: from };
  const childIndent = first.indent;
  if (first.text.startsWith("- ") || first.text === "-") {
    const items: YamlValue[] = [];
    let i = from;
    while (i < lines.length && lines[i]!.indent === childIndent && (lines[i]!.text.startsWith("- ") || lines[i]!.text === "-")) {
      const item = lines[i]!.text.slice(1).trim();
      i++;
      // A nested map or sequence inside an item is beyond this reader.
      if (!item || keyValue(item)) {
        items.push(UNREADABLE);
        while (i < lines.length && lines[i]!.indent > childIndent) i++;
      } else items.push(scalar(item));
    }
    return { value: items, next: i };
  }
  const map: YamlMap = {};
  let i = from;
  while (i < lines.length && lines[i]!.indent >= childIndent) {
    const line = lines[i]!;
    if (line.indent > childIndent) {
      // Over-indented line (a continued plain scalar, or broken YAML): poison the previous key.
      const keys = Object.keys(map);
      if (keys.length) map[keys[keys.length - 1]!] = UNREADABLE;
      i++;
      continue;
    }
    const kv = keyValue(line.text);
    i++;
    if (!kv) {
      map[`\u0000line${i}`] = UNREADABLE;
      continue;
    }
    if (kv.rest) {
      map[kv.key] = Object.hasOwn(map, kv.key) ? UNREADABLE : scalar(kv.rest);
      continue;
    }
    const nested = i < lines.length && (lines[i]!.indent > childIndent || (lines[i]!.indent === childIndent && lines[i]!.text.startsWith("- ")));
    if (!nested) {
      map[kv.key] = null;
      continue;
    }
    const sub = parseLines(lines, i, lines[i]!.indent > childIndent ? childIndent + 1 : childIndent);
    map[kv.key] = Object.hasOwn(map, kv.key) ? UNREADABLE : sub.value;
    i = sub.next;
  }
  return { value: map, next: i };
}

/**
 * The `mcp_servers` map of a Hermes config.yaml: server name → its (partly) parsed entry. null when the file has
 * no single readable block (`{}` and an absent key give an empty map).
 */
export function readMcpServers(yaml: string): YamlMap | null {
  return readTopMap(yaml, "mcp_servers");
}

/** A top-level block map (e.g. `platform_toolsets`), read like mcp_servers. */
export function readTopMap(yaml: string, key: string): YamlMap | null {
  const block = topBlock(yaml, key);
  if (!block) return new RegExp(keyRe(key).source, "m").test(yaml) ? null : {};
  if (block.inline) return block.inline === "{}" || block.inline === "null" || block.inline === "~" ? {} : null;
  const raw = yaml.replace(/^﻿/, "").split("\n").slice(block.start + 1, block.end);
  const lines: Line[] = [];
  for (const l of raw) {
    const text = stripComment(l);
    if (!text.trim()) continue;
    const ws = /^(\s*)/.exec(text)![1]!;
    if (ws.includes("\t")) return null;
    lines.push({ indent: ws.length, text: text.trim() });
  }
  if (!lines.length) return {};
  const { value } = parseLines(lines, 0, 1);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as YamlMap) : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes `mcp_servers.<name>` for each name, keeping everything else byte for byte. Returns null when any of
 * them isn't a plain block entry this can cut out safely (then nothing should be written).
 */
export function removeYamlServers(yaml: string, names: string[]): string | null {
  if (!names.length) return yaml;
  const block = mcpServersBlock(yaml);
  if (!block || block.inline) return null;
  const lines = yaml.split("\n");
  const body = lines.slice(block.start + 1, block.end);
  const first = body.find((l) => l.trim() && !l.trimStart().startsWith("#"));
  if (!first) return null;
  const indent = /^(\s*)/.exec(first)![1]!;
  if (!indent || indent.includes("\t")) return null;
  const isKey = (l: string, name: string) => new RegExp(`^${escapeRe(indent)}(["']?)${escapeRe(name)}\\1\\s*:`).test(l);
  const kept: string[] = [];
  const found = new Set<string>();
  let skipping = false;
  for (const l of body) {
    const own = /^(\s*)/.exec(l)![1]!.length;
    if (l.trim() && !l.trimStart().startsWith("#") && own === indent.length) {
      const hit = names.find((n) => isKey(l, n));
      skipping = !!hit;
      if (hit) {
        if (found.has(hit)) return null;
        found.add(hit);
        // Comment lines right above a removed entry (at its indent or less) were about it: they go with it.
        while (kept.length && kept[kept.length - 1]!.trimStart().startsWith("#") && /^(\s*)/.exec(kept[kept.length - 1]!)![1]!.length <= indent.length) kept.pop();
        // Only block entries: a flow-style `name: { … }` might span lines we can't see the end of.
        if (stripComment(l).replace(/^[^:]*:/, "").trim()) return null;
      }
    } else if (l.trim() && !l.trimStart().startsWith("#") && own < indent.length) return null;
    // A comment at the entries' own indent (or less) introduces the next entry: it's kept with it.
    else if (skipping && l.trimStart().startsWith("#") && own <= indent.length) skipping = false;
    if (!skipping) kept.push(l);
  }
  if (found.size !== names.length) return null;
  const hasChild = kept.some((l) => l.trim() && !l.trimStart().startsWith("#"));
  const head = hasChild ? lines[block.start]! : "mcp_servers: {}";
  return [...lines.slice(0, block.start), head, ...(hasChild ? kept : kept.filter((l) => l.trim())), ...lines.slice(block.end)].join("\n");
}
