import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigFile, codexConfigFile, cursorConfigFile, hermesHome } from "../listen/mcpsetup.ts";
import { readTomlMcpServers, type TomlTable, UNREADABLE as TOML_UNREADABLE } from "./toml.ts";
import { readMcpServers, UNREADABLE as YAML_UNREADABLE, type YamlMap } from "./yaml.ts";

/** Reads the MCP servers an agent's own tool is configured with (for `import --from`). */

export const IMPORT_CLIENTS = ["hermes", "claude-code", "cursor", "codex"] as const;
export type ImportClient = (typeof IMPORT_CLIENTS)[number];

export const CLIENT_LABELS: Record<ImportClient, string> = { hermes: "Hermes", "claude-code": "Claude Code", cursor: "Cursor", codex: "Codex" };

export interface ClientEntry {
  name: string;
  /** The file it's defined in. */
  file: string;
  /** Claude Code: which scope (user: ~/.claude.json; local: its projects[cwd]; project: ./.mcp.json). */
  scope?: "user" | "local" | "project";
  /** Claude Code local/project scope: the project directory (where `claude mcp remove` must run). */
  projectDir?: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  /** Static headers, with ${VAR} references resolved. Secret: never printed. */
  headers: Record<string, string>;
  /** Names of environment variables the headers came from (for the "you can remove it from .env" note). */
  headerVars: string[];
  /** Per header: the environment variables its value was built from (shown in the plan next to the destination). */
  headerSources: Record<string, string[]>;
  /**
   * Defined in a file the project ships (Claude Code's ./.mcp.json), not by the user: anyone who can commit to the
   * repository wrote it. Imported only when Claude Code approved it, and only after its own confirmation.
   */
  fromProject?: boolean;
  /** The client says it uses OAuth (Hermes `auth: oauth`, an oauth block). Its tokens stay in the client. */
  oauth: boolean;
  enabled: boolean;
  /** Why it can't be imported as it is. */
  problem?: string;
  /** stdio: the command line, for the listing. */
  command?: string;
}

export interface ClientConfig {
  client: ImportClient;
  files: string[];
  entries: ClientEntry[];
}

export interface ReadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Parses a dotenv file (KEY=VALUE, optional `export`, quotes). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

type Expanded = { value: string; vars: string[] } | { missing: string };

/** `${VAR}` (and `${VAR:-default}`, `${env:VAR}`) from `vars`. */
export function expandVars(value: string, vars: Record<string, string | undefined>): Expanded {
  const used: string[] = [];
  let missing: string | null = null;
  const out = value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def: string | undefined) => {
    const v = vars[name];
    if (v !== undefined && v !== "") {
      used.push(name);
      return v;
    }
    if (def !== undefined) return def;
    missing ??= name;
    return "";
  });
  return missing ? { missing } : { value: out, vars: used };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const readJson = (file: string): Record<string, unknown> | null => {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  try {
    const doc = JSON.parse(text) as unknown;
    if (!isObj(doc)) throw new Error("not an object");
    return doc;
  } catch {
    throw new Error(`${file} isn't plain JSON (comments?), so it can't be read automatically.`);
  }
};

/** Shared by the JSON-shaped clients (Claude Code, Cursor): one `mcpServers` entry. */
function jsonEntry(name: string, raw: unknown, file: string, vars: Record<string, string | undefined>, extra: Partial<ClientEntry> = {}): ClientEntry {
  const base: ClientEntry = { name, file, transport: "http", headers: {}, headerVars: [], headerSources: {}, oauth: false, enabled: true, ...extra };
  if (!isObj(raw)) return { ...base, problem: "this entry isn't an object" };
  if (raw.disabled === true || raw.enabled === false) base.enabled = false;
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : null;
  if (type === "stdio" || (typeof raw.command === "string" && !raw.url)) {
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    return { ...base, transport: "stdio", command: [String(raw.command ?? ""), ...args].join(" ").trim() };
  }
  if (typeof raw.url !== "string") return { ...base, problem: "no url" };
  const url = expandVars(raw.url, vars);
  if ("missing" in url) return { ...base, problem: `its url uses \${${url.missing}}, which isn't set here` };
  const entry: ClientEntry = { ...base, url: url.value, transport: type === "sse" ? "sse" : "http" };
  if (raw.headersHelper !== undefined || raw.headers_helper !== undefined) return { ...entry, problem: "it gets its headers from a helper command, which the broker can't run" };
  if (raw.oauth !== undefined || raw.auth !== undefined) entry.oauth = true;
  return withHeaders(entry, raw.headers, vars);
}

function withHeaders(entry: ClientEntry, headers: unknown, vars: Record<string, string | undefined>): ClientEntry {
  if (headers === undefined || headers === null) return entry;
  if (!isObj(headers)) return { ...entry, problem: "its headers can't be read" };
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") return { ...entry, problem: `its ${k} header can't be read` };
    const x = expandVars(v, vars);
    if ("missing" in x) return { ...entry, problem: `its ${k} header uses \${${x.missing}}, which isn't set here` };
    entry.headers[k] = x.value;
    entry.headerVars.push(...x.vars);
    entry.headerSources[k] = x.vars;
  }
  return entry;
}

// ───────────── Hermes ─────────────

export function hermesFiles(env: NodeJS.ProcessEnv = process.env): { config: string; env: string } {
  const home = hermesHome(env);
  return { config: join(home, "config.yaml"), env: join(home, ".env") };
}

function readHermes(opts: ReadOptions): ClientConfig {
  const env = opts.env ?? process.env;
  const files = hermesFiles(env);
  const result: ClientConfig = { client: "hermes", files: [files.config], entries: [] };
  if (!existsSync(files.config)) return result;
  const servers = readMcpServers(readFileSync(files.config, "utf8"));
  if (!servers) throw new Error(`${files.config} has an mcp_servers layout this can't read (flow style, several blocks, or tabs). Nothing was changed.`);
  // Hermes loads ~/.hermes/.env into its environment: the secrets its ${VAR} headers name live there.
  const vars = { ...env, ...(existsSync(files.env) ? parseDotenv(readFileSync(files.env, "utf8")) : {}) };
  for (const [name, raw] of Object.entries(servers)) {
    if (name.startsWith("\u0000")) continue;
    const base: ClientEntry = { name, file: files.config, transport: "http", headers: {}, headerVars: [], headerSources: {}, oauth: false, enabled: true };
    if (!raw || raw === YAML_UNREADABLE || typeof raw !== "object" || Array.isArray(raw)) {
      result.entries.push({ ...base, problem: "this entry can't be read" });
      continue;
    }
    const e = raw as YamlMap;
    const unreadable = ["url", "headers", "command", "auth", "transport", "enabled"].find((k) => e[k] === YAML_UNREADABLE);
    if (unreadable) {
      result.entries.push({ ...base, problem: `its ${unreadable} can't be read` });
      continue;
    }
    if (e.enabled === false || (typeof e.enabled === "string" && ["false", "no", "off", "0"].includes(e.enabled.toLowerCase()))) base.enabled = false;
    if (typeof e.command === "string") {
      const args = Array.isArray(e.args) ? e.args.filter((a) => typeof a === "string") : [];
      result.entries.push({ ...base, transport: "stdio", command: [e.command, ...args].join(" ") });
      continue;
    }
    if (typeof e.url !== "string") {
      result.entries.push({ ...base, problem: "no url" });
      continue;
    }
    const url = expandVars(e.url, vars);
    if ("missing" in url) {
      result.entries.push({ ...base, problem: `its url uses \${${url.missing}}, which isn't set in ${files.env}` });
      continue;
    }
    const entry: ClientEntry = {
      ...base,
      url: url.value,
      transport: e.transport === "sse" ? "sse" : "http",
      oauth: e.auth === "oauth" || isObj(e.oauth),
    };
    if (e.client_cert !== undefined || e.identity_header !== undefined) {
      result.entries.push({ ...entry, problem: "it uses a client certificate or identity header, which the broker doesn't support yet" });
      continue;
    }
    result.entries.push(withHeaders(entry, e.headers ?? undefined, vars));
  }
  return result;
}

// ───────────── Claude Code ─────────────

function readClaude(opts: ReadOptions): ClientConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const userFile = claudeConfigFile();
  const projectFile = join(cwd, ".mcp.json");
  const result: ClientConfig = { client: "claude-code", files: [userFile, projectFile].filter(existsSync), entries: [] };
  const seen = new Set<string>();
  const add = (e: ClientEntry) => {
    // Claude Code's precedence: local, then project, then user. A shadowed one isn't what the agent uses.
    if (seen.has(e.name)) return;
    seen.add(e.name);
    result.entries.push(e);
  };
  const doc = readJson(userFile);
  const proj = doc && isObj(doc.projects) && isObj(doc.projects[cwd]) ? (doc.projects[cwd] as Record<string, unknown>) : {};
  const local = proj.mcpServers;
  if (isObj(local)) for (const [n, raw] of Object.entries(local)) add(jsonEntry(n, raw, userFile, env, { scope: "local", projectDir: cwd }));
  const project = readJson(projectFile);
  if (project && isObj(project.mcpServers)) {
    // ./.mcp.json comes with the repository. Claude Code itself only uses the servers the user approved for this
    // project (kept in ~/.claude.json, which the repository can't write); a project's own .claude/settings*.json
    // isn't trusted for this.
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const enabled = new Set(list(proj.enabledMcpjsonServers));
    const disabled = new Set(list(proj.disabledMcpjsonServers));
    const all = proj.enableAllProjectMcpServers === true;
    for (const [n, raw] of Object.entries(project.mcpServers)) {
      const e = jsonEntry(n, raw, projectFile, env, { scope: "project", projectDir: cwd, fromProject: true });
      const why = disabled.has(n) ? "turned off for this project in Claude Code" : !all && !enabled.has(n) ? "not approved in Claude Code" : null;
      // An unapproved one isn't what Claude Code uses, so it doesn't shadow a user-scope server of the same name.
      if (why) result.entries.push({ ...e, problem: why });
      else add(e);
    }
  }
  if (doc && isObj(doc.mcpServers)) for (const [n, raw] of Object.entries(doc.mcpServers)) add(jsonEntry(n, raw, userFile, env, { scope: "user" }));
  return result;
}

// ───────────── Cursor ─────────────

function readCursor(opts: ReadOptions): ClientConfig {
  const env = opts.env ?? process.env;
  const file = cursorConfigFile();
  const result: ClientConfig = { client: "cursor", files: [file], entries: [] };
  const doc = readJson(file);
  if (doc && isObj(doc.mcpServers)) for (const [n, raw] of Object.entries(doc.mcpServers)) result.entries.push(jsonEntry(n, raw, file, env));
  return result;
}

// ───────────── Codex ─────────────

function readCodex(opts: ReadOptions): ClientConfig {
  const env = opts.env ?? process.env;
  const file = codexConfigFile();
  const result: ClientConfig = { client: "codex", files: [file], entries: [] };
  if (!existsSync(file)) return result;
  for (const [name, raw] of Object.entries(readTomlMcpServers(readFileSync(file, "utf8")))) {
    const base: ClientEntry = { name, file, transport: "http", headers: {}, headerVars: [], headerSources: {}, oauth: false, enabled: true };
    if (raw === TOML_UNREADABLE) {
      result.entries.push({ ...base, problem: "this entry can't be read" });
      continue;
    }
    const e = raw as TomlTable;
    if (e.enabled === false) base.enabled = false;
    if (typeof e.command === "string") {
      const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : [];
      result.entries.push({ ...base, transport: "stdio", command: [e.command, ...args].join(" ") });
      continue;
    }
    if (typeof e.url !== "string") {
      result.entries.push({ ...base, problem: "no url" });
      continue;
    }
    const entry: ClientEntry = { ...base, url: e.url, oauth: isObj(e.oauth) || e.auth === "oauth" };
    if (e.http_headers_helper !== undefined) {
      result.entries.push({ ...entry, problem: "it gets its headers from a helper command, which the broker can't run" });
      continue;
    }
    // Codex has no ${VAR} expansion: env_http_headers and bearer_token_env_var name variables instead.
    const headers: Record<string, string> = {};
    let problem: string | undefined;
    if (e.http_headers !== undefined) {
      if (!isObj(e.http_headers) || Object.values(e.http_headers).some((v) => typeof v !== "string")) problem = "its http_headers can't be read";
      else {
        Object.assign(headers, e.http_headers);
        for (const h of Object.keys(e.http_headers)) entry.headerSources[h] = [];
      }
    }
    const fromEnv: Record<string, unknown> = isObj(e.env_http_headers) ? { ...e.env_http_headers } : {};
    if (e.bearer_token_env_var !== undefined) fromEnv.Authorization = e.bearer_token_env_var;
    for (const [h, varName] of Object.entries(fromEnv)) {
      if (typeof varName !== "string") problem ??= `its ${h} header can't be read`;
      else if (!env[varName]) problem ??= `its ${h} header comes from $${varName}, which isn't set here`;
      else {
        headers[h] = h === "Authorization" && e.bearer_token_env_var === varName ? `Bearer ${env[varName]}` : env[varName]!;
        entry.headerVars.push(varName);
        entry.headerSources[h] = [varName];
      }
    }
    entry.headers = headers;
    result.entries.push(problem ? { ...entry, problem } : entry);
  }
  return result;
}

export function readClientConfig(client: ImportClient, opts: ReadOptions = {}): ClientConfig {
  switch (client) {
    case "hermes":
      return readHermes(opts);
    case "claude-code":
      return readClaude(opts);
    case "cursor":
      return readCursor(opts);
    case "codex":
      return readCodex(opts);
  }
}

export function parseImportClient(value: string): ImportClient {
  const v = value.trim().toLowerCase().replace(/^claude$/, "claude-code");
  if (!(IMPORT_CLIENTS as readonly string[]).includes(v)) throw new Error(`Unknown --from "${value}". Choose one of: ${IMPORT_CLIENTS.join(", ")}.`);
  return v as ImportClient;
}
