import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readSetupToken } from "./auth/setup-token.ts";
import type { Config } from "./config.ts";
import { consoleUrls, loopbackUrl } from "./urls.ts";

/** Installs agentinbox as a background service: systemd on Linux, launchd on macOS. */

const NAME = "agentinbox";
const PACKAGE = "agentinbox";
const LABEL = "com.unlaboredlabs.agentinbox";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
/** Package root: one level above the running module (dist/cli.js or server/service.ts). */
const ROOT = resolve(import.meta.dirname, "..");

type ServiceConfig = Pick<Config, "dataDir" | "port" | "host">;

const run = (cmd: string, args: string[], quiet = false) => execFileSync(cmd, args, { stdio: quiet ? "ignore" : "inherit" });

const isRoot = () => process.getuid?.() === 0;
const systemctl = (...args: string[]) => run("systemctl", isRoot() ? args : ["--user", ...args]);
const unitPath = () => (isRoot() ? `/etc/systemd/system/${NAME}.service` : join(homedir(), ".config/systemd/user", `${NAME}.service`));
const plistPath = () => join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const launchdTarget = () => `gui/${process.getuid?.()}`;
const envFilePath = (config: ServiceConfig) => join(config.dataDir, "service.env");

/**
 * The service runs from its own install in the data directory, never from the npx cache (which is
 * pruned at will). From an installed package that is the latest release; from a source checkout,
 * the local build.
 */
function installedEntry(config: ServiceConfig): string {
  const app = join(config.dataDir, "app");
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
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), '{ "private": true }\n');
  try {
    execFileSync(npm, ["install", spec, "--omit=dev", "--prefer-online", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, stdio: "inherit" });
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return join(app, "node_modules", PACKAGE, "dist/cli.js");
}

function environment(config: ServiceConfig): Record<string, string> {
  const env: Record<string, string> = {
    AGENTINBOX_DATA: config.dataDir,
    PORT: String(config.port),
    HOST: config.host,
    AGENTINBOX_SERVICE: "1",
  };
  for (const key of ["TRUST_PROXY", "AGENTINBOX_LOG_LEVEL"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

/**
 * AGENTINBOX_MASTER_KEY must reach the service, or it would generate a new master.key and fail to
 * decrypt existing secrets. It goes into a 0600 env file, never into the (world-readable) unit.
 */
function writeSecretEnv(config: ServiceConfig): boolean {
  const key = process.env.AGENTINBOX_MASTER_KEY;
  const file = envFilePath(config);
  if (!key) {
    rmSync(file, { force: true });
    return false;
  }
  writeFileSync(file, `AGENTINBOX_MASTER_KEY=${key}\n`, { mode: 0o600 });
  return true;
}

/** systemd quoting: wrap in double quotes, escape backslashes, quotes and specifiers. */
const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

function systemdUnit(config: ServiceConfig, entry: string, secretEnv: boolean): string {
  const vars = Object.entries(environment(config))
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=agentinbox (Gmail broker for AI agents)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${sdQuote(process.execPath)} ${sdQuote(entry)} start --no-open
${vars}${secretEnv ? `\nEnvironmentFile=${sdQuote(envFilePath(config))}` : ""}
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=${isRoot() ? "multi-user.target" : "default.target"}
`;
}

function launchdPlist(config: ServiceConfig, entry: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const env = environment(config);
  if (process.env.AGENTINBOX_MASTER_KEY) env.AGENTINBOX_MASTER_KEY = process.env.AGENTINBOX_MASTER_KEY;
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`)
    .join("\n");
  const log = esc(join(config.dataDir, "agentinbox.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(entry)}</string>
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

function assertSupported(): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Service install supports Linux (systemd) and macOS (launchd). Elsewhere, run `agentinbox start` under your own supervisor.");
  }
}

export async function installService(config: ServiceConfig): Promise<void> {
  assertSupported();
  uninstallService(config, true);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const entry = installedEntry(config);

  if (process.platform === "linux") {
    const secretEnv = writeSecretEnv(config);
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(unitPath(), systemdUnit(config, entry, secretEnv));
    systemctl("daemon-reload");
    systemctl("enable", "--now", NAME);
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
    // 0600: the plist may carry AGENTINBOX_MASTER_KEY.
    writeFileSync(plistPath(), launchdPlist(config, entry), { mode: 0o600 });
    run("launchctl", ["bootstrap", launchdTarget(), plistPath()]);
  }

  console.log(`\n  Installed ${NAME} as a ${process.platform === "linux" ? "systemd" : "launchd"} service.`);
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
      systemctl("disable", "--now", NAME);
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
      run("launchctl", ["bootout", `${launchdTarget()}/${LABEL}`], true);
    } catch {
      // Not loaded.
    }
    rmSync(plistPath());
  }
  if (!quiet) console.log(`Removed the ${NAME} service. Your data in ${config.dataDir} was kept.`);
}

export function serviceStatus(): void {
  assertSupported();
  try {
    if (process.platform === "linux") systemctl("status", NAME, "--no-pager");
    else run("launchctl", ["print", `${launchdTarget()}/${LABEL}`]);
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
  console.warn(`  The service did not respond on port ${config.port} yet. Check \`agentinbox service status\`.`);
}
