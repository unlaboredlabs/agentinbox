/**
 * A small TOML reader for Codex's `[mcp_servers.*]` tables, without a TOML library. It reads table headers,
 * dotted and quoted keys, basic and literal strings, numbers, booleans, single- or multi-line arrays of those,
 * and one-line inline tables. Multi-line strings, dates and arrays of tables are UNREADABLE (for their value or
 * table), so the caller can skip an entry it can't read instead of guessing.
 */

export const UNREADABLE = Symbol("unreadable");
export type TomlValue = string | number | boolean | typeof UNREADABLE | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void {
    while (this.i < this.s.length && /[ \t]/.test(this.s[this.i]!)) this.i++;
  }
  /** Whitespace, newlines and comments (inside arrays). */
  wsAll(): void {
    for (;;) {
      while (this.i < this.s.length && /[ \t\r\n]/.test(this.s[this.i]!)) this.i++;
      if (this.s[this.i] !== "#") return;
      while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
    }
  }
  peek(): string | undefined {
    return this.s[this.i];
  }
  done(): boolean {
    return this.i >= this.s.length;
  }
}

class Unreadable extends Error {}

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", e: "\x1b" };

function readString(c: Cursor): string {
  const q = c.peek();
  if (c.s.startsWith(`${q}${q}${q}`, c.i)) throw new Unreadable("multi-line string");
  c.i++;
  let out = "";
  while (!c.done()) {
    const ch = c.s[c.i++]!;
    if (ch === "\n") break;
    if (ch === q) return out;
    if (q === '"' && ch === "\\") {
      const e = c.s[c.i++]!;
      if (ESCAPES[e] !== undefined) out += ESCAPES[e];
      else if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        const hex = c.s.slice(c.i, c.i + len);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new Unreadable("bad escape");
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        c.i += len;
      } else throw new Unreadable("bad escape");
    } else out += ch;
  }
  throw new Unreadable("unterminated string");
}

function readKey(c: Cursor): string[] {
  const parts: string[] = [];
  for (;;) {
    c.ws();
    const ch = c.peek();
    if (ch === '"' || ch === "'") parts.push(readString(c));
    else {
      const m = /^[A-Za-z0-9_-]+/.exec(c.s.slice(c.i));
      if (!m) throw new Unreadable("bad key");
      parts.push(m[0]);
      c.i += m[0].length;
    }
    c.ws();
    if (c.peek() !== ".") return parts;
    c.i++;
  }
}

function readValue(c: Cursor, multiline: boolean): TomlValue {
  const ch = c.peek();
  if (ch === '"' || ch === "'") return readString(c);
  if (ch === "[") {
    c.i++;
    const items: TomlValue[] = [];
    for (;;) {
      if (multiline) c.wsAll();
      else c.ws();
      if (c.peek() === "]") {
        c.i++;
        return items;
      }
      items.push(readValue(c, multiline));
      if (multiline) c.wsAll();
      else c.ws();
      if (c.peek() === ",") c.i++;
      else if (c.peek() !== "]") throw new Unreadable("bad array");
    }
  }
  if (ch === "{") {
    c.i++;
    const table: TomlTable = {};
    c.ws();
    if (c.peek() === "}") {
      c.i++;
      return table;
    }
    for (;;) {
      const key = readKey(c);
      if (c.peek() !== "=") throw new Unreadable("bad inline table");
      c.i++;
      c.ws();
      setPath(table, key, readValue(c, false));
      c.ws();
      if (c.peek() === ",") {
        c.i++;
        continue;
      }
      if (c.peek() === "}") {
        c.i++;
        return table;
      }
      throw new Unreadable("bad inline table");
    }
  }
  const m = /^[^\s,\]}#]+/.exec(c.s.slice(c.i));
  if (!m) throw new Unreadable("missing value");
  c.i += m[0].length;
  if (m[0] === "true") return true;
  if (m[0] === "false") return false;
  const n = m[0].replace(/_/g, "");
  if (/^[-+]?(\d+(\.\d+)?([eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(n)) return Number(n);
  throw new Unreadable("unsupported value");
}

function setPath(table: TomlTable, path: string[], value: TomlValue): void {
  let t = table;
  for (const p of path.slice(0, -1)) {
    const next = t[p];
    if (next === undefined) t = t[p] = {};
    else if (typeof next === "object" && !Array.isArray(next)) t = next as TomlTable;
    else throw new Unreadable("key redefined");
  }
  const last = path[path.length - 1]!;
  if (Object.hasOwn(t, last)) throw new Unreadable("key redefined");
  t[last] = value;
}

function tableAt(root: TomlTable, path: string[]): TomlTable {
  let t = root;
  for (const p of path) {
    const next = t[p];
    if (next === undefined) t = t[p] = {};
    else if (typeof next === "object" && !Array.isArray(next)) t = next as TomlTable;
    else throw new Unreadable("table redefined");
  }
  return t;
}

/**
 * The `mcp_servers` table of a Codex config.toml: server name → entry. A server whose table (or a value in it)
 * can't be read maps to UNREADABLE. Problems outside mcp_servers are ignored.
 */
export function readTomlMcpServers(toml: string): { [name: string]: TomlTable | typeof UNREADABLE } {
  const root: TomlTable = {};
  const bad = new Set<string>();
  let current: string[] = [];
  const lines = toml.replace(/^﻿/, "").split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[[")) {
      const c = new Cursor(trimmed.slice(2));
      try {
        current = ["\u0000array", ...readKey(c)];
      } catch {
        current = ["\u0000array"];
      }
      if (current[1] === "mcp_servers" && current[2]) bad.add(current[2]);
      continue;
    }
    if (trimmed.startsWith("[")) {
      const c = new Cursor(trimmed.slice(1));
      try {
        current = readKey(c);
        if (c.peek() !== "]") throw new Unreadable("bad header");
        if (current[0] === "mcp_servers") tableAt(root, current);
      } catch {
        current = ["\u0000bad"];
      }
      continue;
    }
    if (current[0] !== "mcp_servers" && !/^\s*mcp_servers\s*[.=]/.test(line)) continue;
    // A value may continue over several lines (multi-line arrays): take lines until it parses.
    let text = line;
    let consumed = n;
    let parsed: { key: string[]; value: TomlValue } | null = null;
    for (;;) {
      const c = new Cursor(text);
      try {
        const key = readKey(c);
        if (c.peek() !== "=") throw new Unreadable("missing =");
        c.i++;
        c.ws();
        const value = readValue(c, true);
        c.ws();
        if (!c.done() && c.peek() !== "#") throw new Unreadable("trailing characters");
        parsed = { key, value };
        break;
      } catch {
        const open = (text.match(/\[/g) ?? []).length > (text.match(/]/g) ?? []).length;
        if (!open || consumed + 1 >= lines.length) break;
        text += `\n${lines[++consumed]}`;
      }
    }
    n = consumed;
    const full = parsed ? [...current, ...parsed.key] : current;
    const server = full[0] === "mcp_servers" ? full[1] : current[1];
    if (!parsed) {
      if (server) bad.add(server);
      continue;
    }
    try {
      setPath(root, full, parsed.value);
    } catch {
      if (server) bad.add(server);
    }
  }
  const servers = root.mcp_servers;
  const out: { [name: string]: TomlTable | typeof UNREADABLE } = {};
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [name, entry] of Object.entries(servers as TomlTable)) {
      out[name] = bad.has(name) || !entry || typeof entry !== "object" || Array.isArray(entry) ? UNREADABLE : (entry as TomlTable);
    }
  }
  for (const name of bad) out[name] = UNREADABLE;
  return out;
}
