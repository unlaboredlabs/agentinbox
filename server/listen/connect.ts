import { closeSync, constants, fchmodSync, lstatSync, openSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import pc from "picocolors";
import type { AgentTool, PairingPoll, PairingStart, PairingStartInput } from "../../shared/agent-api.ts";
import { CAPABILITIES, type Capability } from "../../shared/types.ts";
import { ApiError, clientInfo, pollPairing, startPairing } from "./api.ts";
import { writeClaudeMcpConfig } from "./mcpheader.ts";
import { isServiceInstalled } from "./service.ts";
import { setupMcp, mcpTarget, type McpSetupResult } from "./mcpsetup.ts";
import { defaultConsumer, validConsumer } from "./options.ts";
import { DEFAULT_PROFILE, profilePath, validProfileName } from "./paths.ts";
import { listProfiles, loadProfile, type Profile, profileExists, saveProfile } from "./profile.ts";
import { recipe, shellQuote, TOOL_LABELS, TOOLS } from "./recipes.ts";
import { checkTransport, insecureBanner, normalizeDaemonUrl } from "./transport.ts";
import { box, formatDuration, safeText, StatusLine } from "./ui.ts";
import { NPX } from "./version.ts";

export interface ConnectFlags {
  name?: string;
  tool?: string;
  account?: string[];
  capabilities?: string;
  reason?: string;
  profile?: string;
  consumer?: string;
  insecure?: boolean;
  force?: boolean;
  setupMcp?: boolean;
  /** Also write the output (plain text) to this file: created 0600, never through a symlink or someone else's file. */
  log?: string;
}

/** Exit codes, so scripts (and agents setting themselves up) can tell outcomes apart. */
export const CONNECT_EXIT = { approved: 0, error: 1, denied: 2, expired: 3, consumed: 4, cancelled: 130 } as const;

export interface ConnectOptions {
  /** Tests: poll faster than the server's interval. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  handleSignals?: boolean;
}

export function parseTool(value: string | undefined): AgentTool {
  if (value === undefined) return "other";
  const v = value.trim().toLowerCase().replace(/^claude$/, "claude-code");
  if (!(TOOLS as readonly string[]).includes(v)) throw new Error(`Unknown --tool "${value}". Choose one of: ${TOOLS.join(", ")}.`);
  return v as AgentTool;
}

export function parseCapabilities(value: string | undefined): Capability[] | undefined {
  if (value === undefined) return undefined;
  const list = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = list.filter((c) => !(CAPABILITIES as readonly string[]).includes(c));
  if (bad.length) throw new Error(`Unknown capabilit${bad.length > 1 ? "ies" : "y"} ${bad.join(", ")}. Choose from: ${CAPABILITIES.join(", ")}.`);
  return [...new Set(list)] as Capability[];
}

const shortHost = () => hostname().replace(/\.(local|lan|home)$/i, "");

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** --log target (fd), written in parallel with the console. */
let logFd: number | null = null;
const toLog = (s: string) => {
  if (logFd !== null) writeSync(logFd, stripAnsi(s) + "\n");
};
const out = (s = "") => {
  process.stdout.write(`${s}\n`);
  toLog(s);
};
const err = (s = "") => {
  process.stderr.write(`${s}\n`);
  toLog(s);
};

/**
 * Opens --log safely: a new file is created 0600 with O_EXCL; an existing one (e.g. from `mktemp`) is
 * only reused if it is a regular file owned by us, opened without following symlinks. This is what
 * keeps another local user from pre-creating the log and reading the pairing as it happens.
 */
export function openConnectLog(path: string): number {
  try {
    return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  const uid = process.getuid?.();
  if (!st.isFile() || (uid !== undefined && st.uid !== uid)) throw new Error(`Refusing --log ${path}: it exists and is not a regular file owned by you.`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  fchmodSync(fd, 0o600);
  return fd;
}

export async function runConnect(rawUrl: string, flags: ConnectFlags, opts: ConnectOptions = {}): Promise<number> {
  if (flags.log) logFd = openConnectLog(flags.log);
  try {
    return await connect(rawUrl, flags, opts);
  } finally {
    if (logFd !== null) closeSync(logFd);
    logFd = null;
  }
}

async function connect(rawUrl: string, flags: ConnectFlags, opts: ConnectOptions): Promise<number> {
  const url = normalizeDaemonUrl(rawUrl);
  const verdict = await checkTransport(url, { insecure: flags.insecure });
  if (verdict.warning) err(insecureBanner(verdict.warning));

  const profileName = validProfileName(flags.profile ?? DEFAULT_PROFILE);
  let replacing: Profile | null = null;
  if (profileExists(profileName) && flags.force) {
    try {
      replacing = loadProfile(profileName);
    } catch {
      // Unreadable: it's being replaced anyway.
    }
  }
  if (profileExists(profileName) && !flags.force) {
    let who = "";
    try {
      const p = loadProfile(profileName);
      who = ` (agent "${safeText(p.agentName)}" on ${p.url})`;
    } catch {
      // Unreadable: still don't overwrite silently.
    }
    const others = listProfiles();
    throw new Error(
      `Profile "${profileName}" already exists${who}.\n` +
        `  Pair a second agent with --profile <name>${others.length > 1 ? ` (existing: ${others.join(", ")})` : ""}, or replace this one with --force.`,
    );
  }
  const tool = parseTool(flags.tool);
  const capabilities = parseCapabilities(flags.capabilities);
  // --force keeps the listener's consumer, so the server-side cursor carries on (no replay, no gap).
  const consumer = validConsumer(flags.consumer ?? replacing?.consumer ?? defaultConsumer(profileName));
  const name = (flags.name?.trim() || `${tool === "other" ? "Agent" : TOOL_LABELS[tool]} on ${shortHost()}`).slice(0, 80);

  const input: PairingStartInput = {
    name,
    requested: {
      ...(flags.account?.length ? { accounts: flags.account } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(flags.reason ? { reason: flags.reason } : {}),
    },
    client: { ...clientInfo(), tool },
  };

  let start: PairingStart;
  try {
    start = await startPairing(url, input);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error(`${url} doesn't support pairing (no /agent/v1/pairings). Is this an agentinbox daemon, and is it up to date?`);
    }
    if (e instanceof ApiError) throw new Error(`${e.message}${e.hint ? `\n  ${e.hint}` : ""}`);
    throw e;
  }

  out();
  out(
    box([
      pc.bold("Approve this agent in the agentinbox console"),
      "",
      `Code:   ${pc.bold(pc.yellow(safeText(start.userCode, 40)))}`,
      `Open:   ${pc.cyan(safeText(start.verificationUrl, 300))}`,
      `Agent:  ${safeText(name)}`,
      "",
      pc.gray("Only approve if the console shows this exact code."),
    ]),
  );
  out();

  // Ctrl-C: stop cleanly. Nothing was approved; the request just expires.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const onSigint = () => ac.abort();
  if (opts.handleSignals) process.on("SIGINT", onSigint);

  const started = Date.now();
  const expiresAt = Date.parse(start.expiresAt) || started + 10 * 60_000;
  let interval = Math.max(1, start.interval || 5) * 1000;
  let note = "";
  const status = new StatusLine(process.stderr);
  status.start(
    () =>
      `Waiting for approval · ${formatDuration(Date.now() - started)} elapsed · code expires in ${formatDuration(expiresAt - Date.now())}${note ? pc.yellow(` · ${note}`) : ""}`,
  );

  let result: PairingPoll | null = null;
  try {
    while (!ac.signal.aborted) {
      await sleep(opts.pollIntervalMs ?? interval, ac.signal);
      if (ac.signal.aborted) break;
      try {
        const r = await pollPairing(url, start.deviceCode);
        note = "";
        if (r.status === "pending") continue;
        if (r.status === "slow_down") {
          // The server asks for more room between polls.
          interval = Math.max(interval + 1000, (r.interval || 0) * 1000);
          continue;
        }
        result = r;
        break;
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          interval += 5000;
          note = "rate limited, slowing down";
          continue;
        }
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408) {
          throw new Error(`${e.message}${e.hint ? `\n  ${e.hint}` : ""}`);
        }
        // Network trouble or a 5xx: keep trying until the code expires.
        note = "can't reach the daemon, retrying";
        if (Date.now() > expiresAt + 30_000) {
          result = { status: "expired" };
          break;
        }
      }
    }
  } finally {
    status.stop();
    if (opts.handleSignals) process.off("SIGINT", onSigint);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  if (!result) {
    err(pc.yellow("Cancelled. Nothing was approved; the code expires on its own."));
    return CONNECT_EXIT.cancelled;
  }

  switch (result.status) {
    case "denied":
      err(pc.red(`✖ The request was denied in the console${result.note ? `: ${safeText(result.note, 300)}` : "."}`));
      return CONNECT_EXIT.denied;
    case "expired":
      err(pc.red("✖ The code expired before it was approved."));
      err(`  Run the same command again for a fresh code, and approve it within ${formatDuration(Date.parse(start.expiresAt) - started)}.`);
      return CONNECT_EXIT.expired;
    case "consumed":
      err(pc.red("✖ This pairing was already completed and its key handed out once (perhaps by an earlier run of this command)."));
      err(`  For safety the key is never delivered twice. Start over with \`${NPX} connect\`, or rotate the agent's key in the console.`);
      return CONNECT_EXIT.consumed;
    case "approved":
      break;
    default:
      throw new Error(`Unexpected pairing status ${JSON.stringify((result as { status: unknown }).status)}`);
  }

  // --force keeps everything about the listener (targets, filters, limits, forward secret, cwd); only
  // the pairing (daemon, key, agent) is replaced.
  const kept: Partial<Profile> = replacing
    ? {
        types: replacing.types,
        filter: replacing.filter,
        includeBody: replacing.includeBody,
        exec: replacing.exec,
        forward: replacing.forward,
        forwardSecret: replacing.forwardSecret,
        concurrency: replacing.concurrency,
        timeoutSeconds: replacing.timeoutSeconds,
        maxAttempts: replacing.maxAttempts,
        cwd: replacing.cwd,
      }
    : {};
  const profile: Profile = {
    ...kept,
    url,
    apiKey: result.apiKey,
    agentId: result.agent.id,
    agentName: result.agent.name,
    consumer,
    ...(verdict.kind === "insecure" ? { insecure: true } : {}),
    tool,
    // Derived from the URL the user chose and transport-checked; the daemon's advertised URLs come
    // from its publicUrl setting and are never trusted with the key.
    mcpUrl: `${url}/mcp`,
    skillUrl: `${url}/skill.md`,
    createdAt: new Date().toISOString(),
  };
  const path = saveProfile(profileName, profile);
  writeClaudeMcpConfig(profileName, profile.mcpUrl!);
  if (typeof result.mcpUrl === "string" && result.mcpUrl !== profile.mcpUrl) {
    err(
      pc.yellow(
        `! The daemon advertises its MCP endpoint as ${safeText(result.mcpUrl, 200)} (its "public URL" setting); using ${profile.mcpUrl}, the address you connected to. Set the public URL in the console if agents should use another address.`,
      ),
    );
  }

  out(`${pc.green("✔")} Approved. Agent ${pc.bold(safeText(result.agent.name))} ${pc.gray(`(${result.agent.id})`)} is connected.`);
  out(`  Key saved to ${pc.cyan(path)} ${pc.gray("(mode 0600; never displayed. Rotate it in the console if it leaks.)")}`);
  if (replacing && (replacing.exec || replacing.forward)) {
    out(`  Kept this profile's listener settings. Restart the listener to use the new key${isServiceInstalled(profileName) ? `: ${NPX} listen service install${profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`}` : "."}`);
  }
  if (replacing && replacing.agentId !== profile.agentId) {
    err(
      pc.yellow(
        `! Replaced profile "${profileName}" (agent "${safeText(replacing.agentName)}", ${replacing.agentId}). Its key still works until you rotate it or delete that agent in the console; config backups made by setup-mcp (*.agentinbox-backup-*) may contain it.`,
      ),
    );
  }

  let mcp: McpSetupResult | null = null;
  if (flags.setupMcp) {
    mcp = setupMcp(tool, mcpTarget(profileName, profile), path);
    printMcpResult(mcp);
  }
  printNextSteps(profileName, profile, tool, mcp);
  return CONNECT_EXIT.approved;
}

export function printMcpResult(r: McpSetupResult): void {
  if (r.ok) out(`${pc.green("✔")} ${r.message}`);
  else err(`${pc.yellow("!")} ${r.message}`);
  if (r.backup) out(pc.gray(`  Backup: ${r.backup}`));
  if (!r.ok && r.manual?.length) {
    out("  Do it by hand:");
    for (const l of r.manual) out(`    ${l}`);
  }
}

function skillCommand(tool: AgentTool, url: string): string {
  switch (tool) {
    case "claude-code":
      return `${NPX} skill install --target claude --url ${url}`;
    case "codex":
      return `${NPX} skill install --target codex --url ${url}`;
    case "hermes":
      return `${NPX} skill install --target ~/.hermes/skills/email --url ${url}`;
    case "cursor":
      return `${NPX} skill install --target agents --url ${url}`;
    default:
      return `${NPX} skill print --url ${url} > SKILL.md`;
  }
}

export function printNextSteps(profileName: string, profile: Profile, tool: AgentTool, mcp: McpSetupResult | null): void {
  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  const label = tool === "other" ? "your agent" : TOOL_LABELS[tool];
  const r = recipe(tool, profileName);
  const execArg = shellQuote(r.exec);
  out();
  out(pc.bold("Next steps"));
  let n = 1;
  if (mcp?.ok) {
    out(`  ${n++}. ${label} has the agentinbox MCP tools ${pc.gray(`(restart it if it's running)`)}.`);
  } else if (tool === "other") {
    out(`  ${n++}. Point your agent's MCP client at ${pc.cyan(profile.mcpUrl ?? `${profile.url}/mcp`)} with header Authorization: Bearer <key>`);
    out(pc.gray(`     The key is the "apiKey" field in ${profilePath(profileName)}.`));
  } else {
    out(`  ${n++}. Give ${label} the agentinbox MCP tools without ever seeing the key:`);
    out(`       ${pc.cyan(`${NPX} setup-mcp --tool ${tool}${p}`)}`);
  }
  out(`  ${n++}. Install the agentinbox skill so ${label} knows the rules:`);
  out(`       ${pc.cyan(skillCommand(tool, profile.url))}`);
  out(`  ${n++}. Wake ${label} when mail arrives. Try it in the foreground (--save keeps the command in the profile):`);
  out(`       ${pc.cyan(`${NPX} listen${p} --save --exec ${execArg}`)}`);
  out(`     then keep it running in the background (systemd / launchd, starts at login):`);
  out(`       ${pc.cyan(`${NPX} listen service install${p}`)}`);
  out(pc.gray(`     What the woken agent can use: ${r.confinement}.`));
  for (const note of r.notes) out(pc.gray(`     ${note}`));
  out();
  out(pc.gray("  What this agent may do (mailboxes, capabilities, send mode) was set by whoever approved it. New grants are draft-only:"));
  out(pc.gray("  sends become Gmail drafts until the operator changes that in the console."));
  out();
}
