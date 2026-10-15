import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { NPM_PACKAGE as PACKAGE } from "../shared/types.ts";
import { readSetupToken } from "./auth/setup-token.ts";
import type { Config } from "./config.ts";
import { Crypto } from "./crypto.ts";
import { assertMasterKeyUsable, cliCommand } from "./instance.ts";
import { consoleUrls, loopbackUrl } from "./urls.ts";

/** Installs agentinbox as a background service: systemd on Linux, launchd on macOS. */

export const SERVICE_NAME = "agentinbox";
export const LAUNCHD_LABEL = "com.unlaboredlabs.agentinbox";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
/** Package root: one level above the running module (dist/cli.js or server/service.ts). */
const ROOT = resolve(import.meta.dirname, "..");

/**
 * Settings that come from the environment rather than flags. They are kept in `<data>/service.env`
 * (mode 0600) so re-running `service install` from a shell without them (the documented update
 * path) keeps them. Set one to an empty value to drop it.
 */
export const SERVICE_ENV_KEYS = ["AGENTINBOX_MASTER_KEY", "TRUST_PROXY", "TRUST_PROXY_HOPS", "TRUST_PROXY_FROM", "AGENTINBOX_LOG_LEVEL"] as const;

type ServiceConfig = Pick<Config, "dataDir" | "port" | "host" | "dbPath" | "masterKeyPath">;

const run = (cmd: string, args: string[], quiet = false) => execFileSync(cmd, args, { stdio: quiet ? "ignore" : "inherit" });

const isRoot = () => process.getuid?.() === 0;
const systemctl = (...args: string[]) => run("systemctl", isRoot() ? args : ["--user", ...args]);
const unitPath = () => (isRoot() ? `/etc/systemd/system/${SERVICE_NAME}.service` : join(homedir(), ".config/systemd/user", `${SERVICE_NAME}.service`));
const plistPath = () => join(homedir(), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const launchdTarget = () => `gui/${process.getuid?.()}`;
export const serviceEnvPath = (dataDir: string) => join(dataDir, "service.env");

// ───────────── Pure rendering (unit-tested) ─────────────

export interface ServiceSpec {
  /** Node binary. */
  execPath: string;
  /** The installed dist/cli.js. */
  entry: string;
  dataDir: string;
  port: number;
  host: string;
  /** Extra environment from service.env (SERVICE_ENV_KEYS). */
  extraEnv: Record<string, string>;
  /** systemd: system unit (root) rather than a user unit. */
  system?: boolean;
}

/** Plain variables written into the unit/plist. Secrets never go into the systemd unit. */
function plainEnv(spec: ServiceSpec): Record<string, string> {
  return { AGENTINBOX_DATA: spec.dataDir, PORT: String(spec.port), HOST: spec.host, AGENTINBOX_SERVICE: "1" };
}

/** systemd word quoting for ExecStart/Environment: double quotes, escaped backslashes, quotes and specifiers. */
const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/**
 * The systemd unit. Everything from service.env (including AGENTINBOX_MASTER_KEY) is loaded with
 * EnvironmentFile=, so the world-readable unit holds no secrets. EnvironmentFile takes an
 * unquoted absolute path (systemd ignores quoted ones), which is why data dirs with whitespace are refused.
 */
export function renderSystemdUnit(spec: ServiceSpec): string {
  const vars = Object.entries(plainEnv(spec))
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  const envFile = Object.keys(spec.extraEnv).length ? `\nEnvironmentFile=${serviceEnvPath(spec.dataDir).replace(/%/g, "%%")}` : "";
  return `[Unit]
Description=agentinbox (Gmail broker for AI agents)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${sdQuote(spec.execPath)} ${sdQuote(spec.entry)} start --no-open
${vars}${envFile}
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=${spec.system ? "multi-user.target" : "default.target"}
`;
}

/** The launchd plist. Written with mode 0600, since it may carry AGENTINBOX_MASTER_KEY. */
export function renderLaunchdPlist(spec: ServiceSpec): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const vars = Object.entries({ ...plainEnv(spec), ...spec.extraEnv })
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join("\n");
  const log = esc(join(spec.dataDir, "agentinbox.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(spec.execPath)}</string>
    <string>${esc(spec.entry)}</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

/** Parses service.env (KEY=value lines). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/**
 * The service's env-derived settings: the current shell wins, previous install fills the gaps,
 * an explicitly empty value removes the setting.
 */
export function mergeServiceEnv(previous: Record<string, string>, current: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SERVICE_ENV_KEYS) {
    const value = key in current ? current[key] : previous[key];
    // A single comma-separated token, so systemd's EnvironmentFile parsing can't split it.
    if (value) out[key] = key === "TRUST_PROXY_FROM" ? value.split(/[\s,]+/).filter(Boolean).join(",") : value;
  }
  return out;
}

/** Fails early (before anything is touched) when the master key can't work. */
export function validateMasterKey(value: string | undefined): void {
  if (!value) return;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) throw new Error("not base64");
    new Crypto(Buffer.from(value, "base64"));
  } catch {
    throw new Error("AGENTINBOX_MASTER_KEY must be 32 random bytes in base64 (e.g. `openssl rand -base64 32`).");
  }
}

// ───────────── Install ─────────────

function readPreviousEnv(dataDir: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(serviceEnvPath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

function writeServiceEnv(dataDir: string, env: Record<string, string>): void {
  const file = serviceEnvPath(dataDir);
  if (!Object.keys(env).length) {
    rmSync(file, { force: true });
    return;
  }
  for (const [k, v] of Object.entries(env)) {
    if (/[\r\n]/.test(v)) throw new Error(`${k} must be a single line.`);
  }
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
}

/**
 * Installs the package into `<data>/app.new`, so a failed npm install leaves the current service
 * untouched. From an installed package that is the latest release; from a source checkout, the
 * local build. Returns the staging directory.
 */
function stageApp(dataDir: string): string {
  const staging = join(dataDir, "app.new");
  const fromSource = basename(dirname(ROOT)) !== "node_modules";
  let spec = `${PACKAGE}@latest`;
  let tmp: string | undefined;
  if (fromSource) {
    if (!existsSync(join(ROOT, "dist/cli.js")) || !existsSync(join(ROOT, "dist/web/index.html"))) {
      throw new Error("Run `pnpm build` before installing the service from a source checkout.");
    }
    tmp = mkdtempSync(join(tmpdir(), "agentinbox-pack-"));
    const out = execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", tmp, "--loglevel=error"], { cwd: ROOT, encoding: "utf8" });
    spec = join(tmp, out.trim().split("\n").pop()!);
  }

  console.log(fromSource ? "  Installing this build into the data directory…" : "  Installing the latest release into the data directory…");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), '{ "private": true }\n');
  try {
    execFileSync(npm, ["install", spec, "--omit=dev", "--prefer-online", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: staging, stdio: "inherit" });
    if (!existsSync(join(staging, "node_modules", PACKAGE, "dist/cli.js"))) throw new Error("the installed package has no dist/cli.js");
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`Installing agentinbox failed, so the existing service was left as it was. ${err instanceof Error ? err.message : ""}`.trim());
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return staging;
}

/** Replaces `<data>/app` with the staged install (call while the service is stopped). */
function swapApp(dataDir: string, staging: string): string {
  const app = join(dataDir, "app");
  const old = join(dataDir, "app.old");
  rmSync(old, { recursive: true, force: true });
  if (existsSync(app)) renameSync(app, old);
  renameSync(staging, app);
  rmSync(old, { recursive: true, force: true });
  return join(app, "node_modules", PACKAGE, "dist/cli.js");
}

function assertSupported(): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`Service install supports Linux (systemd) and macOS (launchd). Elsewhere, run \`${cliCommand("start")}\` under your own supervisor.`);
  }
}

export async function installService(config: ServiceConfig): Promise<void> {
  assertSupported();
  if (process.platform === "linux" && /\s/.test(config.dataDir)) {
    throw new Error(`The data directory "${config.dataDir}" contains whitespace, which systemd can't load settings from. Choose another one with --data.`);
  }
  const extraEnv = mergeServiceEnv(readPreviousEnv(config.dataDir), process.env);
  validateMasterKey(extraEnv.AGENTINBOX_MASTER_KEY);
  // The service must be able to read what's already stored, with exactly the key it will get.
  assertMasterKeyUsable(config, extraEnv.AGENTINBOX_MASTER_KEY ?? "");
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const staging = stageApp(config.dataDir);
  uninstallService(config, true);
  const entry = swapApp(config.dataDir, staging);
  writeServiceEnv(config.dataDir, extraEnv);
  const spec: ServiceSpec = { execPath: process.execPath, entry, dataDir: config.dataDir, port: config.port, host: config.host, extraEnv, system: isRoot() };

  if (process.platform === "linux") {
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(unitPath(), renderSystemdUnit(spec));
    systemctl("daemon-reload");
    systemctl("enable", "--now", SERVICE_NAME);
    if (!isRoot()) {
      // Keep user services running after logout and start them at boot.
      const user = userInfo().username;
      try {
        run("loginctl", ["enable-linger", user], true);
      } catch {
        console.warn(`  Could not enable lingering. Run \`sudo loginctl enable-linger ${user}\` so the service starts at boot.`);
      }
    }
  } else {
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(plistPath(), renderLaunchdPlist(spec), { mode: 0o600 });
    run("launchctl", ["bootstrap", launchdTarget(), plistPath()]);
  }

  const kept = Object.keys(extraEnv).filter((k) => !(k in process.env));
  console.log(`\n  Installed ${SERVICE_NAME} as a ${process.platform === "linux" ? "systemd" : "launchd"} service.`);
  if (kept.length) console.log(`  Kept ${kept.join(", ")} from the previous install.`);
  await printWhenReady(config);
}

export function uninstallService(config: ServiceConfig, quiet = false): void {
  assertSupported();
  if (process.platform === "linux") {
    if (!existsSync(unitPath())) {
      if (!quiet) console.log("The agentinbox service is not installed.");
      return;
    }
    try {
      systemctl("disable", "--now", SERVICE_NAME);
    } catch {
      // Already stopped.
    }
    rmSync(unitPath());
    systemctl("daemon-reload");
  } else {
    if (!existsSync(plistPath())) {
      if (!quiet) console.log("The agentinbox service is not installed.");
      return;
    }
    try {
      run("launchctl", ["bootout", `${launchdTarget()}/${LAUNCHD_LABEL}`], true);
    } catch {
      // Not loaded.
    }
    rmSync(plistPath());
  }
  if (!quiet) console.log(`Removed the ${SERVICE_NAME} service. Your data in ${config.dataDir} was kept.`);
}

export function serviceStatus(): void {
  assertSupported();
  try {
    if (process.platform === "linux") systemctl("status", SERVICE_NAME, "--no-pager");
    else run("launchctl", ["print", `${launchdTarget()}/${LAUNCHD_LABEL}`]);
  } catch {
    process.exitCode = 1;
  }
}

async function printWhenReady(config: ServiceConfig): Promise<void> {
  const base = loopbackUrl(config.host, config.port);
  for (let i = 0; i < 60; i++) {
    try {
      // 503 means "up but degraded", which is still up.
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 || res.status === 503) {
        const token = readSetupToken(config.dataDir);
        console.log(`  Running at:\n`);
        for (const url of consoleUrls(config.host, config.port)) console.log(`    ${url}${token ? `/setup?token=${token}` : ""}`);
        if (token) console.log(`\n  Open the link above to claim the instance and finish setup.`);
        console.log();
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`  The service did not respond on port ${config.port} yet. Check \`${cliCommand("service status")}\`.`);
}
