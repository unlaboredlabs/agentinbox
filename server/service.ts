import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { NPM_PACKAGE as PACKAGE } from "../shared/types.ts";
import { readSetupToken } from "./auth/setup-token.ts";
import type { Config } from "./config.ts";
import { Crypto } from "./crypto.ts";
import { assertMasterKeyUsable, cliCommand, type InstanceInfo, runningInstance, serviceInstallCommand } from "./instance.ts";
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
export const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

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
  // network-online.target only exists for system units; a user unit waiting on it never starts it.
  const network = spec.system ? "\nAfter=network-online.target\nWants=network-online.target" : "";
  return `[Unit]
Description=agentinbox (Gmail broker for AI agents)${network}

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
/** Escapes text for a plist <string>. */
export const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const esc = xmlEscape;
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
 * Installs the package into `staging` (a fresh private npm prefix), so a failed npm install leaves the
 * current install untouched. From an installed package that is the latest release; from a source
 * checkout, the local build. Returns `staging`. The one install path for the daemon and the listeners.
 */
export function stagePackage(staging: string, opts: { where: string; requireWeb: boolean }): string {
  const fromSource = basename(dirname(ROOT)) !== "node_modules";
  let spec = `${PACKAGE}@latest`;
  let tmp: string | undefined;
  if (fromSource) {
    if (!existsSync(join(ROOT, "dist/cli.js")) || (opts.requireWeb && !existsSync(join(ROOT, "dist/web/index.html")))) {
      throw new Error("Run `pnpm build` before installing the service from a source checkout.");
    }
    tmp = mkdtempSync(join(tmpdir(), "agentinbox-pack-"));
    const out = execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", tmp, "--loglevel=error"], { cwd: ROOT, encoding: "utf8" });
    spec = join(tmp, out.trim().split("\n").pop()!);
  }

  console.log(fromSource ? `  Installing this build into ${opts.where}…` : `  Installing the latest release into ${opts.where}…`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), '{ "private": true }\n');
  try {
    execFileSync(npm, ["install", spec, "--omit=dev", "--prefer-online", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: staging, stdio: "inherit" });
    if (!existsSync(installedEntry(staging))) throw new Error("the installed package has no dist/cli.js");
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`Installing agentinbox failed, so the existing service was left as it was. ${err instanceof Error ? err.message : ""}`.trim());
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return staging;
}

/** The CLI entry inside an install made by stagePackage. */
export const installedEntry = (app: string) => join(app, "node_modules", PACKAGE, "dist/cli.js");

/** Installs into `<dir>/app.new` (see stagePackage). Returns the staging directory. */
export const stageApp = (dir: string): string => stagePackage(join(dir, "app.new"), { where: "the data directory", requireWeb: true });

/**
 * Moves a staged install into place as `app` (the current one becomes `app.old`). `restore()` puts
 * the previous install back; `commit()` deletes it. If the move itself fails, nothing changes.
 */
export function swapIn(staging: string, app: string): { restore(): void; commit(): void } {
  const old = `${app}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(app)) renameSync(app, old);
  try {
    renameSync(staging, app);
  } catch (err) {
    if (existsSync(old)) renameSync(old, app);
    throw err;
  }
  return {
    restore() {
      rmSync(app, { recursive: true, force: true });
      if (existsSync(old)) renameSync(old, app);
    },
    commit() {
      rmSync(old, { recursive: true, force: true });
    },
  };
}

/** Deletes `<dir>/app`, `app.new` and `app.old`, but only where they really are our own installs. */
export function removeOwnInstall(dir: string): void {
  for (const name of ["app", "app.new", "app.old"]) {
    const path = join(dir, name);
    if (existsSync(join(path, "node_modules", PACKAGE))) rmSync(path, { recursive: true, force: true });
  }
}

// ───────────── System integration (injectable for tests) ─────────────

export interface ServiceOps {
  platform: NodeJS.Platform;
  /** systemd: install a system unit (running as root) rather than a user unit. */
  root: boolean;
  /** Runs a command, throwing on a non-zero exit. */
  exec(cmd: string, args: string[], opts?: { quiet?: boolean }): void;
  /** Runs a command and returns its stdout, throwing on a non-zero exit. */
  capture(cmd: string, args: string[]): string;
  /** Installs the package into a staging directory and returns it (see stageApp). */
  stage(dataDir: string): string;
  /** Directory for the systemd unit or the launchd plist. */
  unitDir(): string;
  /** Resolves true once /api/health returns a real HealthResponse, false if it never does. */
  waitReady(config: ServiceConfig): Promise<boolean>;
  /** The live process holding the data directory's instance lock (runningInstance), if any. */
  instance(dataDir: string): InstanceInfo | null;
  /** Whether something already listens on host:port (port 0 never is). */
  portInUse(host: string, port: number): Promise<boolean>;
  uid: number;
  user: string;
}

export const systemOps = (): ServiceOps => {
  const root = process.getuid?.() === 0;
  const ops: ServiceOps = {
    platform: process.platform,
    root,
    exec: (cmd, args, opts) => void execFileSync(cmd, args, { stdio: opts?.quiet ? "ignore" : "inherit" }),
    capture: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    stage: stageApp,
    unitDir: () => {
      if (process.platform === "darwin") return join(homedir(), "Library/LaunchAgents");
      if (root) return "/etc/systemd/system";
      unitDirCache ??= join(userManagerConfigHome(ops) ?? join(homedir(), ".config"), "systemd/user");
      return unitDirCache;
    },
    waitReady: waitForHealth,
    instance: runningInstance,
    portInUse,
    uid: process.getuid?.() ?? 0,
    user: userInfo().username,
  };
  let unitDirCache: string | undefined;
  return ops;
};

/**
 * XDG_CONFIG_HOME as the systemd user manager sees it (where `systemctl --user` looks for units),
 * which can differ from this shell's. Null when unset there or the manager can't be asked.
 */
export function userManagerConfigHome(ops: Pick<ServiceOps, "capture">): string | null {
  try {
    const env = ops.capture("systemctl", ["--user", "show-environment"]);
    return /^XDG_CONFIG_HOME=(.+)$/m.exec(env)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

const unitFile = (ops: ServiceOps) => join(ops.unitDir(), ops.platform === "darwin" ? `${LAUNCHD_LABEL}.plist` : `${SERVICE_NAME}.service`);
export const systemctl = (ops: ServiceOps, ...args: string[]) => ops.exec("systemctl", ops.root ? args : ["--user", ...args]);
export const launchdTarget = (ops: ServiceOps) => `gui/${ops.uid}`;

export function assertSupported(ops: ServiceOps): void {
  if (ops.platform !== "linux" && ops.platform !== "darwin") {
    throw new Error(
      `Service install supports Linux (systemd) and macOS (launchd). Elsewhere, install the command (\`npm i -g ${PACKAGE}\`) and run \`agentinbox start\` under your own supervisor.`,
    );
  }
}

export const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Where to look when the service doesn't start. */
export function serviceHints(ops: ServiceOps, env: NodeJS.ProcessEnv = process.env): string[] {
  if (ops.platform === "darwin") {
    return [`launchctl print ${launchdTarget(ops)}/${LAUNCHD_LABEL}`, "and the log file agentinbox.log in the data directory"];
  }
  const scope = ops.root ? "" : " --user";
  const hints = [`systemctl${scope} status ${SERVICE_NAME}`, `journalctl${scope} -u ${SERVICE_NAME} -e`];
  if (!ops.root && !env.XDG_RUNTIME_DIR) {
    hints.push(
      "XDG_RUNTIME_DIR is not set, so there may be no systemd user session (common over `su` or `sudo -u`). " +
        `Log in as ${ops.user} directly (e.g. over ssh), or run \`sudo loginctl enable-linger ${ops.user}\` and then ` +
        `\`export XDG_RUNTIME_DIR=/run/user/${ops.uid}\` before installing.`,
    );
  }
  return hints;
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

/** Fails before anything is touched when systemd can't be reached (e.g. no user bus over su). */
export function preflight(ops: ServiceOps): void {
  if (ops.platform !== "linux") return;
  try {
    systemctl(ops, "daemon-reload");
  } catch (err) {
    const hints = serviceHints(ops).map((h) => `    ${h}`).join("\n");
    throw new Error(`Can't talk to systemd${ops.root ? "" : " (user session)"}: ${firstLine(err)}. Nothing was changed.\n${hints}`);
  }
}

/** Whether host:port can't be bound because something already listens there. */
function portInUse(host: string, port: number): Promise<boolean> {
  if (!port) return Promise.resolve(false);
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => done(err.code === "EADDRINUSE"));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => done(false)));
  });
}

/** The service manager's main pid for the agentinbox service; null when it isn't running or can't be asked. */
export function serviceMainPid(ops: ServiceOps): number | null {
  try {
    const out =
      ops.platform === "darwin"
        ? (/^\s*pid = (\d+)/m.exec(ops.capture("launchctl", ["print", `${launchdTarget(ops)}/${LAUNCHD_LABEL}`]))?.[1] ?? "")
        : ops.capture("systemctl", [...(ops.root ? [] : ["--user"]), "show", "-p", "MainPID", "--value", SERVICE_NAME]).trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Refuses (before anything is touched) while agentinbox already runs outside the service: in a
 * terminal on this data directory (its instance lock), or anything on the port while the service
 * isn't running. The service could only fail to start, and the health check would hear the other one.
 * A lock holder is the service when its lock says so, or (early nightlies didn't write that flag)
 * when, with a unit installed, it is the service manager's main process.
 */
export async function assertNothingElseRunning(config: Pick<ServiceConfig, "dataDir" | "host" | "port">, ops: ServiceOps, unitInstalled: boolean): Promise<void> {
  const other = ops.instance(config.dataDir);
  const mainPid = unitInstalled ? serviceMainPid(ops) : null;
  if (other && !other.service && other.pid !== mainPid) {
    throw new Error(
      `agentinbox is already running in a terminal (pid ${other.pid}${other.port ? `, port ${other.port}` : ""}): stop it with Ctrl-C, then run this again. ` +
        `The service uses the same data directory (${config.dataDir}), and only one agentinbox can use it at a time. Nothing was changed.`,
    );
  }
  // A running service (on whatever data directory) may hold the port; reinstalling stops it first.
  if (!other && mainPid === null && (await ops.portInUse(config.host, config.port))) {
    throw new Error(
      `Port ${config.port} is already in use: by agentinbox running in a terminal with another --data directory, or by another program. ` +
        `Stop it (Ctrl-C in its terminal), or choose another port with --port. Nothing was changed.`,
    );
  }
}

/**
 * After the health check answered: whether the data directory's lock holder is the new service's own
 * process. It must be the service manager's main process (or, when that pid is unknown, say in its lock
 * that it is the service), and not the process that held the lock before the install. This checks the
 * lock holder, not who answered: agentinbox binds its port before taking the lock and exits when the
 * port is taken, so a service that holds the lock is the one listening. Null when it is; else why not.
 */
export function notTheService(owner: InstanceInfo | null, before: InstanceInfo | null, mainPid: number | null): string | null {
  if (!owner) return "no agentinbox holds the data directory";
  const same = before && owner.pid === before.pid && owner.startedAt === before.startedAt;
  const isService = mainPid !== null ? owner.pid === mainPid : !!owner.service;
  if (same || !isService) return `the agentinbox holding the data directory (pid ${owner.pid}) is not the service${mainPid ? ` (pid ${mainPid})` : ""}`;
  return null;
}

export async function installService(config: ServiceConfig, ops: ServiceOps = systemOps()): Promise<void> {
  assertSupported(ops);
  if (ops.platform === "linux" && /\s/.test(config.dataDir)) {
    throw new Error(`The data directory "${config.dataDir}" contains whitespace, which systemd can't load settings from. Choose another one with --data.`);
  }
  const extraEnv = mergeServiceEnv(readPreviousEnv(config.dataDir), process.env);
  validateMasterKey(extraEnv.AGENTINBOX_MASTER_KEY);
  // The service must be able to read what's already stored, with exactly the key it will get.
  assertMasterKeyUsable(config, extraEnv.AGENTINBOX_MASTER_KEY ?? "");
  preflight(ops);
  const file = unitFile(ops);
  const previousUnit = readText(file);
  await assertNothingElseRunning(config, ops, previousUnit !== null);
  const before = ops.instance(config.dataDir);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const staging = ops.stage(config.dataDir);
  const previousEnv = readText(serviceEnvPath(config.dataDir));
  const app = join(config.dataDir, "app");
  const entry = installedEntry(app);
  const spec: ServiceSpec = { execPath: process.execPath, entry, dataDir: config.dataDir, port: config.port, host: config.host, extraEnv, system: ops.root };
  let swap: ReturnType<typeof swapIn> | null = null;

  try {
    uninstallService(config, ops, { quiet: true, keepApp: true });
    swap = swapIn(staging, app);
    writeServiceEnv(config.dataDir, extraEnv);
    mkdirSync(ops.unitDir(), { recursive: true });
    if (ops.platform === "linux") {
      writeFileSync(file, renderSystemdUnit(spec));
      systemctl(ops, "daemon-reload");
      systemctl(ops, "enable", "--now", SERVICE_NAME);
    } else {
      // 0600: the plist may carry AGENTINBOX_MASTER_KEY.
      writeFileSync(file, renderLaunchdPlist(spec), { mode: 0o600 });
      ops.exec("launchctl", ["bootstrap", launchdTarget(ops), file]);
    }
    if (!(await ops.waitReady(config))) throw new Error(`it did not answer on port ${config.port}`);
    // Something else (a foreground agentinbox started meanwhile) may have answered instead.
    const wrong = notTheService(ops.instance(config.dataDir), before, serviceMainPid(ops));
    if (wrong) throw new Error(wrong);
  } catch (err) {
    rollback();
    const hints = serviceHints(ops).map((h) => `    ${h}`).join("\n");
    throw new Error(
      `Starting the service failed (${firstLine(err)}). Rolled back to ${previousUnit ? "the previous install" : "no service"}.\n  To find out why:\n${hints}`,
    );
  }
  swap!.commit();

  function rollback(): void {
    const quietly = (fn: () => void) => {
      try {
        fn();
      } catch {
        // Best effort: report the original failure.
      }
    };
    quietly(() => uninstallService(config, ops, { quiet: true, keepApp: true }));
    quietly(() => rmSync(file, { force: true }));
    if (ops.platform === "linux") quietly(() => systemctl(ops, "daemon-reload"));
    quietly(() => rmSync(staging, { recursive: true, force: true }));
    if (swap) quietly(() => swap!.restore());
    quietly(() => (previousEnv === null ? rmSync(serviceEnvPath(config.dataDir), { force: true }) : writeFileSync(serviceEnvPath(config.dataDir), previousEnv, { mode: 0o600 })));
    if (previousUnit !== null) {
      quietly(() => {
        writeFileSync(file, previousUnit, { mode: ops.platform === "darwin" ? 0o600 : 0o644 });
        if (ops.platform === "linux") {
          systemctl(ops, "daemon-reload");
          systemctl(ops, "enable", "--now", SERVICE_NAME);
        } else {
          ops.exec("launchctl", ["bootstrap", launchdTarget(ops), file]);
        }
      });
    }
  }

  enableLinger(ops);

  const kept = Object.keys(extraEnv).filter((k) => !(k in process.env));
  console.log(`\n  Installed ${SERVICE_NAME} as a ${ops.platform === "linux" ? "systemd" : "launchd"} service.`);
  console.log(
    `  It runs the Node.js at ${process.execPath} (v${process.versions.node}). If you remove or replace that Node, run \`${serviceInstallCommand(config)}\` again.`,
  );
  if (kept.length) console.log(`  Kept ${kept.join(", ")} from the previous install.`);
  printLinks(config);
}

/** Keeps user services running after logout and starts them at boot (systemd user units only). */
export function enableLinger(ops: ServiceOps): void {
  if (ops.platform !== "linux" || ops.root) return;
  try {
    ops.exec("loginctl", ["enable-linger", ops.user], { quiet: true });
  } catch {
    console.warn(`  Could not enable lingering. Run \`sudo loginctl enable-linger ${ops.user}\` so the service starts at boot.`);
  }
}

/** AGENTINBOX_DATA from an installed unit or plist. */
export function unitDataDir(text: string): string | null {
  const systemd = /^Environment="AGENTINBOX_DATA=((?:[^"\\]|\\.)*)"/m.exec(text);
  if (systemd) return systemd[1]!.replace(/\\(.)/g, "$1").replace(/%%/g, "%");
  const plist = /<key>AGENTINBOX_DATA<\/key><string>([^<]*)<\/string>/.exec(text);
  if (plist) return plist[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return null;
}

/**
 * Stops and removes the service. The data directory is the one the installed unit uses (falling
 * back to `config.dataDir`), and only directories that really are the service's own install are
 * deleted; nothing is created.
 */
export function uninstallService(
  config: Pick<ServiceConfig, "dataDir">,
  ops: ServiceOps = systemOps(),
  opts: { quiet?: boolean; keepApp?: boolean } = {},
): void {
  assertSupported(ops);
  const file = unitFile(ops);
  const unitText = readText(file);
  const dataDir = (unitText && unitDataDir(unitText)) || config.dataDir;
  if (unitText === null) {
    if (!opts.quiet) console.log("The agentinbox service is not installed.");
  } else {
    if (ops.platform === "linux") {
      try {
        systemctl(ops, "disable", "--now", SERVICE_NAME);
      } catch {
        // Already stopped.
      }
      rmSync(file);
      systemctl(ops, "daemon-reload");
    } else {
      try {
        ops.exec("launchctl", ["bootout", `${launchdTarget(ops)}/${LAUNCHD_LABEL}`], { quiet: true });
      } catch {
        // Not loaded.
      }
      rmSync(file);
    }
    if (!opts.quiet) console.log(`Removed the ${SERVICE_NAME} service. Your data in ${dataDir} was kept.`);
  }
  // The service's own install; the data (database, keys) stays.
  if (!opts.keepApp) removeOwnInstall(dataDir);
}

export function serviceStatus(ops: ServiceOps = systemOps()): void {
  assertSupported(ops);
  if (!existsSync(unitFile(ops))) {
    console.log(`The agentinbox service is not installed. Install it with \`${cliCommand("service install")}\`.`);
    process.exitCode = 1;
    return;
  }
  try {
    if (ops.platform === "linux") systemctl(ops, "status", SERVICE_NAME, "--no-pager");
    else ops.exec("launchctl", ["print", `${launchdTarget(ops)}/${LAUNCHD_LABEL}`]);
  } catch {
    process.exitCode = 1;
  }
}

/** A real HealthResponse (not the "starting" placeholder or something else on the port). */
export function isHealthResponse(body: unknown): boolean {
  const b = body as { status?: unknown; version?: unknown } | null;
  return !!b && (b.status === "ok" || b.status === "degraded") && typeof b.version === "string";
}

/** Polls /api/health for up to ~45 s. 503 with a HealthResponse means "up but degraded", which is up. */
async function waitForHealth(config: ServiceConfig): Promise<boolean> {
  const base = loopbackUrl(config.host, config.port);
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if ((res.status === 200 || res.status === 503) && isHealthResponse(await res.json().catch(() => null))) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function printLinks(config: ServiceConfig): void {
  const token = readSetupToken(config.dataDir);
  console.log(`  Running at:\n`);
  for (const url of consoleUrls(config.host, config.port)) console.log(`    ${url}${token ? `/setup?token=${token}` : ""}`);
  if (token) console.log(`\n  Open the link above to claim the instance and finish setup.`);
  console.log();
}
