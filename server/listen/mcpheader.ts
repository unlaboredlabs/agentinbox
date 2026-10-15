import { join } from "node:path";
import { writePrivateFile } from "./fsutil.ts";
import { configDir, profilePath, validProfileName } from "./paths.ts";
import { loadProfile } from "./profile.ts";

/**
 * Keeps the API key out of argv and out of agent config files: Claude Code's `headersHelper` runs a
 * command at connection time and uses the JSON it prints as request headers. The helper is a tiny
 * dependency-free script next to the profiles (stable, unlike the npx cache) that reads the key from
 * the 0600 profile and prints `{"Authorization":"Bearer …"}` to Claude Code's pipe, never a terminal.
 */

export const helperScriptPath = () => join(configDir(), "bin", "mcp-header.mjs");
/** The MCP config the Claude Code recipe loads with --strict-mcp-config (no key inside). */
export const claudeMcpConfigPath = (profile: string) => join(configDir(), "mcp", `${validProfileName(profile)}.claude.json`);

/** POSIX single-quoting for the shell Claude Code runs the helper in. */
const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

export function helperScript(profilesDir: string): string {
  return `#!/usr/bin/env node
// agentinbox MCP header helper (written by \`agentinbox connect\` / \`setup-mcp\`). Prints the
// Authorization header for one agentinbox profile as JSON for Claude Code's headersHelper.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const name = process.argv[2] || "default";
if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) { console.error("invalid profile name"); process.exit(2); }
if (process.stdout.isTTY) { console.error("This prints a secret header; it is meant to be piped to an MCP client."); process.exit(2); }
const profile = JSON.parse(readFileSync(join(${JSON.stringify(profilesDir)}, name + ".json"), "utf8"));
process.stdout.write(JSON.stringify({ Authorization: "Bearer " + profile.apiKey }));
`;
}

/** Writes (or refreshes) the helper script, 0700. Returns the shell command for headersHelper. */
export function installHeaderHelper(profile: string): string {
  const name = validProfileName(profile);
  const path = helperScriptPath();
  writePrivateFile(path, helperScript(join(configDir(), "profiles")));
  // writePrivateFile leaves 0600; the script itself is run through node, so it needn't be executable.
  return `${sq(process.execPath)} ${sq(path)} ${name}`;
}

/** Claude Code MCP server entry: URL plus the helper, no secret. */
export function claudeServerEntry(url: string, profile: string): { type: "http"; url: string; headersHelper: string } {
  return { type: "http", url, headersHelper: installHeaderHelper(profile) };
}

/** Writes the per-profile MCP config the Claude Code listener recipe uses. Returns its path. */
export function writeClaudeMcpConfig(profile: string, url: string): string {
  const path = claudeMcpConfigPath(profile);
  // The recipe allows exactly `mcp__agentinbox`, so the server is always named agentinbox in this file.
  writePrivateFile(path, JSON.stringify({ mcpServers: { agentinbox: claudeServerEntry(url, profile) } }, null, 2) + "\n");
  return path;
}

/** `agentinbox mcp-header`: the header JSON for MCP clients that run a helper. Refuses to print to a terminal. */
export function printMcpHeader(profile: string): number {
  const name = validProfileName(profile);
  if (process.stdout.isTTY) {
    process.stderr.write(`This prints the agent's secret Authorization header; pipe it into the tool that needs it (profile file: ${profilePath(name)}).\n`);
    return 2;
  }
  const p = loadProfile(name);
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${p.apiKey}` }));
  return 0;
}
