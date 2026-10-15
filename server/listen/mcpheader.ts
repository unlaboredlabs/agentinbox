import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIN_NODE, nodeVersionError } from "../node-check.ts";
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

/** Node installs whose path names one version, so upgrading or removing that version breaks anything that recorded it. */
const VERSIONED_NODE = /\/\.?fnm\/node-versions\/|\/\.?nvm\/versions\/node\/|\/\.volta\/tools\/image\/node\/|\/\.asdf\/installs\/nodejs\/|\/mise\/installs\/node\/|\/n\/versions\/node\/|\/Cellar\/node(@\d+)?\//;

export interface NodeChoice {
  /** The node binary recorded in the header helper command. */
  path: string;
  /** `path` is version-specific: replacing or removing that Node breaks the helper. */
  versioned: boolean;
}

/** A node binary that runs and is new enough for the helper (ESM with node: imports). */
function worksAsNode(path: string): boolean {
  if (!existsSync(path)) return false;
  const r = spawnSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  const major = /^v(\d+)\./.exec(r.stdout ?? "")?.[1];
  return r.status === 0 && major !== undefined && Number(major) >= 18;
}

/**
 * The node to record for Claude Code's header helper. A version manager's node (fnm, nvm, Volta, asdf,
 * mise, n, a Homebrew Cellar keg) disappears on upgrade, so prefer a path that stays put: the same
 * Homebrew keg's opt/ link (then the prefix's bin/node), fnm's default alias, or a system node, but only
 * when it exists and runs.
 * Version-manager shims that pick a version per directory (asdf, mise, Volta) aren't used: Claude Code
 * runs the helper in whatever project it's in. Otherwise the current node is kept (and reported).
 */
export function helperNode(execPath = process.execPath, works: (path: string) => boolean = worksAsNode): NodeChoice {
  if (!VERSIONED_NODE.test(execPath)) return { path: execPath, versioned: false };
  const candidates: string[] = [];
  // Homebrew: <prefix>/opt/node@22 (or opt/node) follows the same formula across upgrades; bin/node may be another one.
  const cellar = /^(.*)\/Cellar\/(node(?:@\d+)?)\//.exec(execPath);
  if (cellar) candidates.push(join(cellar[1]!, "opt", cellar[2]!, "bin", "node"), join(cellar[1]!, "bin", "node"));
  // fnm: ~/.local/share/fnm (or the older ~/.fnm)/node-versions/… → <fnm dir>/aliases/default.
  const fnm = /^(.*\/\.?fnm)\/node-versions\//.exec(execPath);
  if (fnm) candidates.push(join(fnm[1]!, "aliases", "default", "bin", "node"));
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  const stable = candidates.find((c) => c !== execPath && !VERSIONED_NODE.test(c) && works(c));
  return stable ? { path: stable, versioned: false } : { path: execPath, versioned: true };
}

/** `node --version` of a binary ("22.20.0"), or null when it doesn't run. */
export function nodeVersionOf(path: string): string | null {
  if (!existsSync(path)) return null;
  const r = spawnSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  const v = /^v(\d+\.\d+\.\d+)/.exec(r.stdout ?? "")?.[1];
  return r.status === 0 && v ? v : null;
}

export interface ServiceNodeChoice extends NodeChoice {
  version: string;
  /** Why this node, in words (printed by `listen service install`). */
  why: string;
}

/**
 * The node the listener service runs on: the same stable-path preference as the header helper (a path
 * that survives fnm/nvm/Homebrew upgrades), but only a node new enough for agentinbox (MIN_NODE); else
 * this shell's node, reported as version-specific.
 */
export function serviceNode(execPath = process.execPath, versionOf: (path: string) => string | null = nodeVersionOf, current = process.versions.node): ServiceNodeChoice {
  const versions = new Map<string, string | null>();
  const okVersion = (p: string) => {
    if (!versions.has(p)) versions.set(p, versionOf(p));
    const v = versions.get(p);
    return !!v && nodeVersionError(v) === null;
  };
  const choice = helperNode(execPath, okVersion);
  if (choice.path !== execPath) {
    return { ...choice, version: versions.get(choice.path)!, why: `a stable path that survives fnm/nvm upgrades (this shell's is ${execPath}, v${current})` };
  }
  return {
    ...choice,
    version: current,
    why: choice.versioned
      ? `this shell's node; its path belongs to one Node version (no stable node ${MIN_NODE}+ found in the usual places), so re-run install after upgrading or removing it`
      : "this shell's node",
  };
}

let chosenNode: NodeChoice | undefined;
/** helperNode() for this process, computed once (it may run a candidate's --version). */
export const helperNodeChoice = (): NodeChoice => (chosenNode ??= helperNode());

/** The shell command Claude Code runs as headersHelper (nothing is written). */
export const headerHelperCommand = (profile: string) => `${sq(helperNodeChoice().path)} ${sq(helperScriptPath())} ${validProfileName(profile)}`;

/** The note setup-mcp prints about the recorded node (like `listen service install`'s Node.js line). */
export function helperNodeNote(profile: string, rerun: string): string {
  const { path, versioned } = helperNodeChoice();
  const v = path === process.execPath ? ` (v${process.versions.node})` : "";
  return versioned
    ? `Node.js: Claude Code runs the header helper with ${path}${v}. That path belongs to one Node version: if you upgrade or remove it, run \`${rerun}\` again.`
    : `Node.js: Claude Code runs the header helper with ${path}${v}; if you remove it, run \`${rerun}\` again.`;
}

/** Writes (or refreshes) the helper script, 0700. Returns the shell command for headersHelper. */
export function installHeaderHelper(profile: string): string {
  const command = headerHelperCommand(profile);
  writePrivateFile(helperScriptPath(), helperScript(join(configDir(), "profiles")));
  // writePrivateFile leaves 0600; the script itself is run through node, so it needn't be executable.
  return command;
}

/** Claude Code MCP server entry: URL plus the helper, no secret. `install: false` (dry runs) doesn't write the helper. */
export function claudeServerEntry(url: string, profile: string, opts: { install?: boolean } = {}): { type: "http"; url: string; headersHelper: string } {
  return { type: "http", url, headersHelper: opts.install === false ? headerHelperCommand(profile) : installHeaderHelper(profile) };
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
