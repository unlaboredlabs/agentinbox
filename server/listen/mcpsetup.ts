import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "../../shared/agent-api.ts";
import { backupFile, isTooOpen, writePrivateFile } from "./fsutil.ts";
import { claudeServerEntry, helperScriptPath } from "./mcpheader.ts";
import type { Profile } from "./profile.ts";
import { mcpServerName } from "./recipes.ts";
import { NPX } from "./version.ts";
import { safeText } from "./ui.ts";

/**
 * `--setup-mcp`: registers the agentinbox MCP server in the agent's own tool without the key ever
 * being shown or pasted. Every file we modify is backed up first; the key is redacted from any
 * output we relay.
 */

export interface McpSetupResult {
  ok: boolean;
  /** What happened, safe to print (never contains the key). */
  message: string;
  backup?: string | null;
  /** Manual steps when automatic setup isn't possible. Never contains the key. */
  manual?: string[];
  /** Exactly what was (or, in a dry run, would be) changed. Never contains the key. */
  changes?: string[];
  /** How to check it worked. */
  verify?: string[];
  /** Nothing was changed (--dry-run). */
  dryRun?: boolean;
}

export interface McpSetupOptions {
  /** Print what would change; change nothing. */
  dryRun?: boolean;
}

/** Placeholder shown wherever the key would go in printed file contents. */
const KEY_SHOWN = "<the key from your agentinbox profile>";
const backupLine = (file: string) => (existsSync(file) ? `back up ${file} to ${file}.agentinbox-backup-<timestamp> (0600)` : `${file} doesn't exist yet: nothing to back up`);
const indent = (text: string) =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => `    ${l}`);

export interface McpSetupTarget {
  name: string;
  url: string;
  key: string;
}

const redact = (s: string, key: string) => s.split(key).join("aib_…(redacted)");

/**
 * The MCP endpoint is always derived from the URL the user connected to (and transport-checked
 * there), never taken from the daemon: a daemon's advertised mcpUrl comes from its publicUrl setting,
 * which defaults to http://localhost:8425 and could also point the key somewhere else entirely.
 */
export function mcpTarget(profileName: string, profile: Profile): McpSetupTarget & { profile: string } {
  return { name: mcpServerName(profileName), url: `${profile.url}/mcp`, key: profile.apiKey, profile: profileName };
}

export function setupMcp(tool: AgentTool, t: McpSetupTarget & { profile?: string }, profileFile: string, opts: McpSetupOptions = {}): McpSetupResult {
  switch (tool) {
    case "claude-code":
      return setupClaude(t, t.profile ?? "default", opts);
    case "codex":
      return setupCodex(t, profileFile, opts);
    case "cursor":
      return setupCursor(t, profileFile, opts);
    case "hermes":
      return setupHermes(t, profileFile, opts);
    default:
      return { ok: false, message: "No automatic MCP setup for --tool other.", manual: manualGeneric(t, profileFile) };
  }
}

function manualGeneric(t: McpSetupTarget, profileFile: string): string[] {
  return [
    `MCP endpoint (streamable HTTP): ${t.url}`,
    `Header: Authorization: Bearer <key>. The key is the "apiKey" field in ${profileFile}; tools that run a header helper can use \`${NPX} mcp-header\`, which prints it as JSON to a pipe.`,
  ];
}

// ───────────── Claude Code ─────────────

export const claudeConfigFile = () => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json"));

function setupClaude(t: McpSetupTarget, profile: string, opts: McpSetupOptions): McpSetupResult {
  // headersHelper: Claude Code asks our helper for the header at connect time, so the key is never in
  // argv (visible in `ps`), in ~/.claude.json, or on screen.
  const json = JSON.stringify(claudeServerEntry(t.url, profile, { install: !opts.dryRun }));
  const addCommand = `claude mcp add-json --scope user ${t.name} '${json.replace(/'/g, `'"'"'`)}'`;
  const manual = [addCommand];
  const file = claudeConfigFile();
  const verify = [`claude mcp list   (shows "${t.name}" as connected; inside Claude Code: /mcp)`];
  const changes = [
    `write the header helper ${helperScriptPath()} (0600; reads the key from your profile when Claude Code connects)`,
    backupLine(file),
    `run: claude mcp remove ${t.name} --scope user   (drops an earlier "${t.name}" entry, if any)`,
    `run: ${addCommand}`,
    `the key stays in your agentinbox profile: neither the command line nor ${file} contains it`,
  ];
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Claude Code: nothing was changed. setup-mcp would:`, changes, verify };
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return { ok: false, message: "The `claude` CLI was not found on PATH.", manual };
  const backup = backupFile(file);
  // `add-json` refuses an existing name, so replace it. argv arrays only, and nothing secret in them.
  spawnSync("claude", ["mcp", "remove", t.name, "--scope", "user"], { stdio: "ignore" });
  const r = spawnSync("claude", ["mcp", "add-json", "--scope", "user", t.name, json], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    const out = redact(`${r.stderr ?? ""}${r.stdout ?? ""}`, t.key).trim();
    return { ok: false, message: `claude mcp add-json failed${out ? `: ${safeText(out, 300)}` : ""}`, backup, manual };
  }
  if (existsSync(file) && isTooOpen(file)) chmodSync(file, 0o600);
  return {
    ok: true,
    message: `Registered MCP server "${t.name}" in Claude Code (user scope). The key stays in your agentinbox profile; Claude Code asks for it through a header helper.`,
    backup,
    changes: [`ran: ${addCommand}`, `${file} now lists "${t.name}" (user scope)`],
    verify,
  };
}

// ───────────── Codex (~/.codex/config.toml) ─────────────

export const codexConfigFile = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tomlString = (s: string) => JSON.stringify(s);

/** Removes `[mcp_servers.<name>]` and its sub-tables from a TOML document, or returns null if it's defined in a form we won't rewrite safely. */
export function removeTomlServer(toml: string, name: string): string | null {
  const keyForms = `(?:${escapeRe(name)}|"${escapeRe(name)}"|'${escapeRe(name)}')`;
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${keyForms}\\s*(?:\\.[^\\]]*)?\\]\\s*(?:#.*)?$`);
  const anyHeader = /^\s*\[/;
  // Inline or dotted definitions (`mcp_servers = { … }`, `mcp_servers.agentinbox.url = …`): leave to the human.
  if (new RegExp(`^\\s*mcp_servers\\s*(?:=|\\.\\s*${keyForms}\\s*[.=])`, "m").test(toml)) return null;
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (anyHeader.test(line)) skipping = header.test(line);
    // Our own marker comment sits just above the table: drop it too, so re-running doesn't pile them up.
    if (!skipping && line.trim() !== CODEX_MARKER) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

const CODEX_MARKER = "# Added by `agentinbox setup-mcp`. The key is also in your agentinbox profile; rotate it in the console.";

export function codexBlock(t: McpSetupTarget): string {
  return [
    CODEX_MARKER,
    `[mcp_servers.${t.name}]`,
    `url = ${tomlString(t.url)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${t.key}`)} }`,
    `# codex exec never prompts: approve agentinbox tools up front (the grant's send mode still applies).`,
    `default_tools_approval_mode = "approve"`,
    "",
  ].join("\n");
}

function setupCodex(t: McpSetupTarget, profileFile: string, opts: McpSetupOptions): McpSetupResult {
  const file = codexConfigFile();
  const manual = [
    `Add to ${file}:`,
    `  [mcp_servers.${t.name}]`,
    `  url = "${t.url}"`,
    `  http_headers = { Authorization = "Bearer <key>" }   # <key>: the apiKey field of ${profileFile}`,
    `  default_tools_approval_mode = "approve"`,
  ];
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const without = removeTomlServer(current, t.name);
  if (without === null) return { ok: false, message: `${file} defines mcp_servers inline; not rewriting it automatically.`, manual };
  const verify = [`codex mcp list   (shows "${t.name}")`];
  const replaces = without !== current.replace(/\n{3,}/g, "\n\n") ? `replace [mcp_servers.${t.name}] in` : `add [mcp_servers.${t.name}] to`;
  const changes = [backupLine(file), `${replaces} ${file} (other tables are kept) and set the file to 0600, since it will hold the key:`, ...indent(codexBlock({ ...t, key: KEY_SHOWN }))];
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Codex: nothing was changed. setup-mcp would:`, changes, verify };
  const backup = backupFile(file);
  const base = without.replace(/\s*$/, "");
  writePrivateFile(file, `${base ? `${base}\n\n` : ""}${codexBlock(t)}`, { privateDir: false });
  return { ok: true, message: `Added [mcp_servers.${t.name}] to ${file} (now mode 0600: it holds the key).`, backup, verify };
}

// ───────────── Cursor (~/.cursor/mcp.json) ─────────────

export const cursorConfigFile = () => join(homedir(), ".cursor", "mcp.json");

function setupCursor(t: McpSetupTarget, profileFile: string, opts: McpSetupOptions): McpSetupResult {
  const file = cursorConfigFile();
  const manual = [
    `Add to ${file} under "mcpServers":`,
    `  "${t.name}": { "url": "${t.url}", "headers": { "Authorization": "Bearer <key>" } }   // <key>: the apiKey field of ${profileFile}`,
  ];
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    if (text.trim()) {
      try {
        doc = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { ok: false, message: `${file} is not plain JSON (comments?); not rewriting it automatically.`, manual };
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, message: `${file} is not a JSON object.`, manual };
    }
  }
  const servers = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers) ? (doc.mcpServers as Record<string, unknown>) : {};
  const verify = [`agent mcp list   (Cursor CLI; or Cursor Settings → MCP shows "${t.name}")`];
  const entry = (key: string) => ({ url: t.url, headers: { Authorization: `Bearer ${key}` } });
  const changes = [
    backupLine(file),
    `${t.name in servers ? "replace" : "add"} "mcpServers.${t.name}" ${t.name in servers ? "in" : "to"} ${file} (other servers are kept) and set the file to 0600, since it will hold the key:`,
    ...indent(`"${t.name}": ${JSON.stringify(entry(KEY_SHOWN), null, 2)}`),
  ];
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Cursor: nothing was changed. setup-mcp would:`, changes, verify };
  servers[t.name] = entry(t.key);
  doc.mcpServers = servers;
  const backup = backupFile(file);
  writePrivateFile(file, JSON.stringify(doc, null, 2) + "\n", { privateDir: false });
  return { ok: true, message: `Added "${t.name}" to ${file} (now mode 0600: it holds the key). Cursor may ask you to enable it once.`, backup, verify };
}

// ───────────── Hermes (~/.hermes/config.yaml + ~/.hermes/.env) ─────────────

export const hermesHome = () => process.env.HERMES_HOME || join(homedir(), ".hermes");
export const hermesEnvVar = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY";

/**
 * Inserts or replaces `mcp_servers.<name>` in a YAML document without a YAML library, handling the
 * common block-style layout. Returns null for anything unusual (flow style, anchors, odd indentation).
 */
export function upsertYamlServer(yaml: string, name: string, entry: string[]): string | null {
  const lines = yaml.split("\n");
  const top = lines.findIndex((l) => /^mcp_servers\s*:/.test(l));
  const block = (indent: string) => [`${indent}${name}:`, ...entry.map((e) => `${indent}${indent}${e}`)];
  if (top < 0) {
    const base = yaml.replace(/\s*$/, "");
    return `${base ? `${base}\n\n` : ""}mcp_servers:\n${block("  ").join("\n")}\n`;
  }
  const rest = lines[top]!.replace(/^mcp_servers\s*:/, "").replace(/#.*$/, "").trim();
  if (rest && rest !== "{}" && rest !== "null" && rest !== "~") return null;
  if (rest) lines[top] = "mcp_servers:";
  // The block runs until the next non-blank line at column 0.
  let end = top + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))) end++;
  const body = lines.slice(top + 1, end);
  const firstChild = body.find((l) => l.trim() && !l.trimStart().startsWith("#"));
  const indent = firstChild ? firstChild.match(/^(\s*)/)![1]! : "  ";
  if (!indent || /\t/.test(indent)) return null;
  const kept: string[] = [];
  let skipping = false;
  for (const l of body) {
    const own = l.match(/^(\s*)/)![1]!.length;
    if (l.trim() && own === indent.length) skipping = new RegExp(`^${escapeRe(indent)}["']?${escapeRe(name)}["']?\\s*:`).test(l);
    else if (l.trim() && own < indent.length) return null;
    if (!skipping) kept.push(l);
  }
  const insert = block(indent);
  return [...lines.slice(0, top + 1), ...insert, ...kept, ...lines.slice(end)].join("\n");
}

function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${escapeRe(key)}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const base = text.replace(/\s*$/, "");
  return `${base ? `${base}\n` : ""}${line}\n`;
}

function setupHermes(t: McpSetupTarget, profileFile: string, opts: McpSetupOptions): McpSetupResult {
  const home = hermesHome();
  const configFile = join(home, "config.yaml");
  const envFile = join(home, ".env");
  const envVar = hermesEnvVar(t.name);
  const entry = [`url: ${JSON.stringify(t.url)}`, `headers:`, `  Authorization: "Bearer \${${envVar}}"`];
  const manual = [
    `Add to ${configFile}:`,
    `  mcp_servers:`,
    `    ${t.name}:`,
    ...entry.map((e) => `      ${e}`),
    `and to ${envFile}:  ${envVar}=<key>   (<key>: the apiKey field of ${profileFile})`,
    `then check it with: hermes mcp test ${t.name}`,
  ];
  const current = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const next = upsertYamlServer(current, t.name, entry);
  if (next === null) return { ok: false, message: `${configFile} uses a layout we won't rewrite automatically.`, manual };
  const verify = [`hermes mcp test ${t.name}`];
  const changes = [
    backupLine(configFile),
    backupLine(envFile),
    `add (or replace) "mcp_servers.${t.name}" in ${configFile} (0600):`,
    ...indent(["mcp_servers:", `  ${t.name}:`, ...entry.map((e) => `    ${e}`)].join("\n")),
    `set ${envVar}=${KEY_SHOWN} in ${envFile} (0600; Hermes' place for secrets)`,
  ];
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Hermes: nothing was changed. setup-mcp would:`, changes, verify };
  const envCurrent = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const backup = backupFile(configFile);
  const envBackup = backupFile(envFile);
  writePrivateFile(envFile, upsertEnvLine(envCurrent, envVar, t.key), { privateDir: false });
  writePrivateFile(configFile, next.endsWith("\n") ? next : `${next}\n`, { privateDir: false });
  return {
    ok: true,
    message: `Added "${t.name}" to ${configFile}; the key is in ${envFile} as ${envVar} (0600).`,
    backup: [backup, envBackup].filter(Boolean).join(", ") || null,
    verify,
  };
}
