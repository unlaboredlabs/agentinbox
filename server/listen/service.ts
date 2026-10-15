import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import pc from "picocolors";
import {
  assertSupported,
  enableLinger,
  installedEntry,
  launchdTarget,
  preflight,
  readText,
  removeOwnInstall,
  sdQuote,
  type ServiceOps,
  swapIn,
  systemctl,
  systemOps,
  xmlEscape,
} from "../service.ts";
import { ensurePrivateDir } from "./fsutil.ts";
import { EXIT } from "./listen.ts";
import { type ListenFlags, resolveListen } from "./options.ts";
import { DEFAULT_PROFILE, dataDir, listenAppDir, logPath, profilePath, profileStateDir, validProfileName } from "./paths.ts";
import { loadProfile, saveProfile } from "./profile.ts";
import { pidAlive, readStatus } from "./state.ts";
import { checkTransport } from "./transport.ts";
import { NPX } from "./version.ts";

/**
 * `agentinbox listen service install|uninstall|status`: one systemd user unit / launchd agent per
 * profile, running from a stable install (not the npx cache). The unit only says which profile to
 * run; settings and the key stay in the 0600 profile file. Installation reuses the daemon's
 * machinery (server/service.ts): systemd pre-check, the user manager's unit directory, staging into
 * app.new and swapping in, rollback when the new listener doesn't start.
 */

export const unitName = (profile: string) => `agentinbox-listen-${profile}`;
export const launchdLabel = (profile: string) => `com.unlaboredlabs.agentinbox.listen.${profile}`;

/**
 * PATH for the service: this shell's PATH (so `claude`, `codex`… resolve as they do here) minus
 * transient entries npx, npm scripts and version-manager shells add, plus node's own directory.
 */
export function servicePath(raw = process.env.PATH ?? ""): string {
  const transient = /\/_npx\/|node_modules\/\.bin|node-gyp-bin|fnm_multishells|\/\.pnpm\//;
  const dirs = [dirname(process.execPath), ...raw.split(delimiter)].filter((d) => d && d.startsWith("/") && !transient.test(d));
  if (!dirs.includes("/usr/bin")) dirs.push("/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(dirs)].join(delimiter);
}

/** Environment the service needs to behave like the shell `service install` ran in. Never contains the key. */
export function serviceEnvironment(): Record<string, string> {
  const env: Record<string, string> = { AGENTINBOX_SERVICE: "1" };
  // PATH matters most: `claude`, `codex`, `hermes`… usually live in ~/.local/bin, nvm or Homebrew dirs
  // that a service manager's minimal PATH doesn't include.
  env.PATH = servicePath();
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME", "LANG", "AGENTINBOX_DEBUG"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

export function systemdListenUnit(profile: string, entry: string, cwd: string, system = false): string {
  const vars = Object.entries(serviceEnvironment())
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=agentinbox listener (profile ${profile})${system ? "\nAfter=network-online.target\nWants=network-online.target" : ""}
StartLimitIntervalSec=0

[Service]
ExecStart=${sdQuote(process.execPath)} ${sdQuote(entry)} listen --profile ${profile}
WorkingDirectory=${cwd.replace(/%/g, "%%")}
${vars}
Restart=on-failure
RestartSec=10
RestartSteps=6
RestartMaxDelaySec=600
# ${EXIT.revoked}: the key was revoked or the config is invalid. Restarting can't fix that.
RestartPreventExitStatus=${EXIT.revoked}
TimeoutStopSec=20

[Install]
WantedBy=${system ? "multi-user.target" : "default.target"}
`;
}

export function launchdListenPlist(profile: string, entry: string, cwd: string): string {
  const esc = xmlEscape;
  const vars = Object.entries(serviceEnvironment())
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join("\n");
  // The listener logs to the rotated listen.log and stays quiet on the console under launchd; only
  // crashes reach stderr, so this file stays small.
  const errLog = esc(join(profileStateDir(profile), "service-stderr.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(launchdLabel(profile))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(entry)}</string>
    <string>listen</string>
    <string>--profile</string>
    <string>${esc(profile)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${errLog}</string>
</dict>
</plist>
`;
}

const unitFile = (ops: ServiceOps, profile: string) =>
  join(ops.unitDir(), ops.platform === "darwin" ? `${launchdLabel(profile)}.plist` : `${unitName(profile)}.service`);

/** Installed listener profiles (from the unit directory). */
function installedProfiles(ops: ServiceOps): string[] {
  const dir = ops.unitDir();
  if (!existsSync(dir)) return [];
  const re = ops.platform === "darwin" ? /^com\.unlaboredlabs\.agentinbox\.listen\.(.+)\.plist$/ : /^agentinbox-listen-(.+)\.service$/;
  return readdirSync(dir)
    .map((f) => re.exec(f)?.[1])
    .filter((p): p is string => !!p);
}

export function isServiceInstalled(profile: string, ops: ServiceOps = systemOps()): boolean {
  if (ops.platform !== "linux" && ops.platform !== "darwin") return false;
  try {
    return existsSync(unitFile(ops, profile));
  } catch {
    return false;
  }
}

function listenerHints(ops: ServiceOps, profile: string): string[] {
  if (ops.platform === "darwin") return [`launchctl print ${launchdTarget(ops)}/${launchdLabel(profile)}`, `the log ${logPath(profile)}`];
  const scope = ops.root ? "" : " --user";
  return [`systemctl${scope} status ${unitName(profile)}`, `journalctl${scope} -u ${unitName(profile)} -e`, `the log ${logPath(profile)}`];
}

/** Resolves true once a listener started after `since` is running for the profile (it writes status.json on start). */
export async function waitListenerStarted(profile: string, since: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readStatus(profile);
    if (st && Date.parse(st.startedAt) >= since - 1000) {
      if (st.stoppedAt) return false;
      if (pidAlive(st.pid)) return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startUnit(ops: ServiceOps, profile: string, file: string): void {
  if (ops.platform === "linux") {
    systemctl(ops, "daemon-reload");
    systemctl(ops, "enable", unitName(profile));
    // restart, not start: a re-install must pick up the new install and settings.
    systemctl(ops, "restart", unitName(profile));
  } else {
    try {
      ops.exec("launchctl", ["bootout", `${launchdTarget(ops)}/${launchdLabel(profile)}`], { quiet: true });
    } catch {
      // Not loaded.
    }
    ops.exec("launchctl", ["bootstrap", launchdTarget(ops), file]);
  }
}

export interface ListenServiceDeps {
  ops?: ServiceOps;
  /** Readiness check after (re)starting the unit (tests). */
  waitStarted?: (profile: string, since: number) => Promise<boolean>;
}

export async function installListenService(flags: ListenFlags, deps: ListenServiceDeps = {}): Promise<void> {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  const profileName = validProfileName(flags.profile ?? DEFAULT_PROFILE);
  const profile = loadProfile(profileName);
  // Service settings live in the profile: save whatever was passed with this command.
  const { config, next } = resolveListen(profileName, profile, { ...flags, save: true });
  if (!config.exec && !config.forward) {
    throw new Error(`Nothing for the service to run. Pass --exec "<command>" and/or --forward <url> (they are saved to profile "${profileName}").`);
  }
  await checkTransport(next.url, { insecure: config.insecure });
  preflight(ops);
  saveProfile(profileName, next);

  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  // Commands run in config.cwd (a private dir unless --cwd was given); the unit uses it too.
  const cwd = config.cwd;
  mkdirSync(profileStateDir(profileName), { recursive: true, mode: 0o700 });
  if (config.cwdIsDefault) ensurePrivateDir(cwd);

  // The same install path as the daemon: stage into <data>/app.new, swap into <data>/app.
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const staging = ops.stage(dataDir());
  const app = listenAppDir();
  const entry = installedEntry(app);
  const file = unitFile(ops, profileName);
  const previousUnit = readText(file);
  const since = Date.now();
  let swap: ReturnType<typeof swapIn> | null = null;
  try {
    swap = swapIn(staging, app);
    mkdirSync(ops.unitDir(), { recursive: true });
    if (ops.platform === "linux") writeFileSync(file, systemdListenUnit(profileName, entry, cwd, ops.root));
    else writeFileSync(file, launchdListenPlist(profileName, entry, cwd), { mode: 0o600 });
    // Right after a bootout, launchd can still be tearing the old job down: retry briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        startUnit(ops, profileName, file);
        break;
      } catch (err) {
        if (ops.platform !== "darwin" || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!(await (deps.waitStarted ?? waitListenerStarted)(profileName, since))) throw new Error("the listener did not start");
  } catch (err) {
    const quietly = (fn: () => void) => {
      try {
        fn();
      } catch {
        // Best effort: report the original failure.
      }
    };
    if (swap) quietly(() => swap!.restore());
    // The settings this install saved go back too, so the restored listener runs as before.
    quietly(() => saveProfile(profileName, profile));
    quietly(() => rmSync(staging, { recursive: true, force: true }));
    if (previousUnit !== null) {
      quietly(() => {
        writeFileSync(file, previousUnit, { mode: ops.platform === "darwin" ? 0o600 : 0o644 });
        startUnit(ops, profileName, file);
      });
    } else {
      quietly(() => uninstallListenService(profileName, true, { ops }));
    }
    const hints = listenerHints(ops, profileName).map((h) => `    ${h}`).join("\n");
    throw new Error(
      `Starting the listener service failed (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}). Rolled back to ${previousUnit ? "the previous install" : "no service"}.\n  To find out why:\n${hints}`,
    );
  }
  swap.commit();
  enableLinger(ops);
  // The other profiles' listeners share the install: move them onto the new one.
  for (const other of installedProfiles(ops).filter((o) => o !== profileName)) {
    try {
      if (ops.platform === "linux") systemctl(ops, "try-restart", unitName(other));
      else ops.exec("launchctl", ["kickstart", "-k", `${launchdTarget(ops)}/${launchdLabel(other)}`], { quiet: true });
    } catch {
      // Not running: nothing to restart.
    }
  }

  const kind = ops.platform === "linux" ? (ops.root ? "systemd system service" : "systemd user service") : "launchd agent";
  console.log(`\n  ${pc.green("✔")} Installed the listener for profile "${profileName}" as a ${kind} (${ops.platform === "linux" ? unitName(profileName) : launchdLabel(profileName)}).`);
  console.log(`    Runs:      ${config.exec ? `--exec ${config.exec}` : ""}${config.exec && config.forward ? "  and  " : ""}${config.forward ? `--forward ${config.forward.url}` : ""}`);
  console.log(`    Directory: ${cwd}${config.cwdIsDefault ? " (private; pass --cwd to run in a project)" : ""}`);
  console.log(`    Node.js:   ${process.execPath} (v${process.versions.node}); if you remove or replace it, run \`${NPX} listen service install${p}\` again.`);
  console.log(`    Settings:  ${profilePath(profileName)} (change them with \`${NPX} listen${p} … --save\`, then reinstall)`);
  console.log(`    Log:       ${logPath(profileName)}`);
  console.log(`    Status:    ${NPX} listen status${p}`);
  if (ops.platform === "linux") console.log(`    Follow:    journalctl ${ops.root ? "" : "--user "}-u ${unitName(profileName)} -f`);
  console.log();
}

export function uninstallListenService(profileName: string, quiet = false, deps: ListenServiceDeps = {}): void {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  const name = validProfileName(profileName);
  const file = unitFile(ops, name);
  if (!existsSync(file)) {
    if (!quiet) console.log(`No listener service is installed for profile "${name}".`);
    return;
  }
  if (ops.platform === "linux") {
    try {
      systemctl(ops, "disable", "--now", unitName(name));
    } catch {
      // Already stopped.
    }
    rmSync(file);
    systemctl(ops, "daemon-reload");
  } else {
    try {
      ops.exec("launchctl", ["bootout", `${launchdTarget(ops)}/${launchdLabel(name)}`], { quiet: true });
    } catch {
      // Not loaded.
    }
    rmSync(file);
  }
  // The last listener gone: remove the shared install too (only if it really is ours).
  if (!installedProfiles(ops).length) removeOwnInstall(dataDir());
  if (!quiet) console.log(`Removed the listener service for profile "${name}". The profile (and its key) was kept: ${profilePath(name)}`);
}

export function listenServiceStatus(profileName: string, deps: ListenServiceDeps = {}): void {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  const name = validProfileName(profileName);
  if (!isServiceInstalled(name, ops)) {
    console.log(`No listener service is installed for profile "${name}". Install one with \`${NPX} listen service install\`.`);
    process.exitCode = 1;
    return;
  }
  try {
    if (ops.platform === "linux") systemctl(ops, "status", unitName(name), "--no-pager");
    else ops.exec("launchctl", ["print", `${launchdTarget(ops)}/${launchdLabel(name)}`]);
  } catch {
    process.exitCode = 1;
  }
}
