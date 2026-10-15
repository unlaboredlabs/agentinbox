import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import pc from "picocolors";
import {
  assertSupported,
  enableLinger,
  installPackage,
  isRoot,
  launchAgentPath,
  launchdTarget,
  run,
  sdQuote,
  systemctl,
  systemdUnitPath,
  xmlEscape,
} from "../service.ts";
import { ensurePrivateDir } from "./fsutil.ts";
import { EXIT } from "./listen.ts";
import { type ListenFlags, resolveListen } from "./options.ts";
import { DEFAULT_PROFILE, listenAppDir, logPath, profilePath, profileStateDir, validProfileName } from "./paths.ts";
import { loadProfile, saveProfile } from "./profile.ts";
import { checkTransport } from "./transport.ts";
import { NPM_PACKAGE, NPX } from "./version.ts";

/**
 * `agentinbox listen service install|uninstall|status`: one systemd user unit / launchd agent per
 * profile, running from a stable install (not the npx cache). The unit only says which profile to
 * run; settings and the key stay in the 0600 profile file.
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

export function systemdListenUnit(profile: string, entry: string, cwd: string): string {
  const vars = Object.entries(serviceEnvironment())
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=agentinbox listener (profile ${profile})
After=network-online.target
Wants=network-online.target
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
WantedBy=${isRoot() ? "multi-user.target" : "default.target"}
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

const unitFile = (profile: string) => systemdUnitPath(unitName(profile));
const plistFile = (profile: string) => launchAgentPath(launchdLabel(profile));

/** Other installed listener profiles (they share the app install, so they restart onto the new one). */
function otherInstalled(profile: string): string[] {
  const dir = dirname(process.platform === "linux" ? unitFile(profile) : plistFile(profile));
  if (!existsSync(dir)) return [];
  const re = process.platform === "linux" ? /^agentinbox-listen-(.+)\.service$/ : /^com\.unlaboredlabs\.agentinbox\.listen\.(.+)\.plist$/;
  return readdirSync(dir)
    .map((f) => re.exec(f)?.[1])
    .filter((p): p is string => !!p && p !== profile);
}

export function isServiceInstalled(profile: string): boolean {
  if (process.platform === "linux") return existsSync(unitFile(profile));
  if (process.platform === "darwin") return existsSync(plistFile(profile));
  return false;
}

export async function installListenService(flags: ListenFlags): Promise<void> {
  assertSupported();
  const profileName = validProfileName(flags.profile ?? DEFAULT_PROFILE);
  const profile = loadProfile(profileName);
  // Service settings live in the profile: save whatever was passed with this command.
  const { config, next } = resolveListen(profileName, profile, { ...flags, save: true });
  if (!config.exec && !config.forward) {
    throw new Error(`Nothing for the service to run. Pass --exec "<command>" and/or --forward <url> (they are saved to profile "${profileName}").`);
  }
  await checkTransport(next.url, { insecure: config.insecure });
  saveProfile(profileName, next);

  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  // Install first (into a new dir, swapped in on success); the current unit keeps running until then.
  const entry = installPackage(listenAppDir(), { where: listenAppDir(), requireWeb: false, pkg: NPM_PACKAGE });
  // Commands run in config.cwd (a private dir unless --cwd was given); the unit uses it too.
  const cwd = config.cwd;
  mkdirSync(profileStateDir(profileName), { recursive: true, mode: 0o700 });
  if (config.cwdIsDefault) ensurePrivateDir(cwd);

  if (process.platform === "linux") {
    mkdirSync(dirname(unitFile(profileName)), { recursive: true });
    writeFileSync(unitFile(profileName), systemdListenUnit(profileName, entry, cwd));
    systemctl("daemon-reload");
    systemctl("enable", unitName(profileName));
    // restart, not start: a re-install must pick up the new install and settings.
    systemctl("restart", unitName(profileName));
    enableLinger();
    for (const other of otherInstalled(profileName)) {
      try {
        systemctl("try-restart", unitName(other));
      } catch {
        // Not running: nothing to restart.
      }
    }
  } else {
    mkdirSync(dirname(plistFile(profileName)), { recursive: true });
    try {
      run("launchctl", ["bootout", `${launchdTarget()}/${launchdLabel(profileName)}`], true);
    } catch {
      // Not loaded yet.
    }
    writeFileSync(plistFile(profileName), launchdListenPlist(profileName, entry, cwd), { mode: 0o600 });
    run("launchctl", ["bootstrap", launchdTarget(), plistFile(profileName)]);
    for (const other of otherInstalled(profileName)) {
      try {
        run("launchctl", ["kickstart", "-k", `${launchdTarget()}/${launchdLabel(other)}`], true);
      } catch {
        // Not loaded.
      }
    }
  }

  const kind = process.platform === "linux" ? (isRoot() ? "systemd system service" : "systemd user service") : "launchd agent";
  console.log(`\n  ${pc.green("✔")} Installed the listener for profile "${profileName}" as a ${kind} (${process.platform === "linux" ? unitName(profileName) : launchdLabel(profileName)}).`);
  console.log(`    Runs:      ${config.exec ? `--exec ${config.exec}` : ""}${config.exec && config.forward ? "  and  " : ""}${config.forward ? `--forward ${config.forward.url}` : ""}`);
  console.log(`    Directory: ${cwd}${config.cwdIsDefault ? " (private; pass --cwd to run in a project)" : ""}`);
  console.log(`    Settings:  ${profilePath(profileName)} (change them with \`${NPX} listen${p} … --save\`, then restart)`);
  console.log(`    Log:       ${logPath(profileName)}`);
  console.log(`    Status:    ${NPX} listen status${p}`);
  if (process.platform === "linux") console.log(`    Follow:    journalctl ${isRoot() ? "" : "--user "}-u ${unitName(profileName)} -f`);
  console.log();
}

export function uninstallListenService(profileName: string, quiet = false): void {
  assertSupported();
  const name = validProfileName(profileName);
  if (!isServiceInstalled(name)) {
    if (!quiet) console.log(`No listener service is installed for profile "${name}".`);
    return;
  }
  if (process.platform === "linux") {
    try {
      systemctl("disable", "--now", unitName(name));
    } catch {
      // Already stopped.
    }
    rmSync(unitFile(name));
    systemctl("daemon-reload");
  } else {
    try {
      run("launchctl", ["bootout", `${launchdTarget()}/${launchdLabel(name)}`], true);
    } catch {
      // Not loaded.
    }
    rmSync(plistFile(name));
  }
  if (!quiet) console.log(`Removed the listener service for profile "${name}". The profile (and its key) was kept: ${profilePath(name)}`);
}

export function listenServiceStatus(profileName: string): void {
  assertSupported();
  const name = validProfileName(profileName);
  if (!isServiceInstalled(name)) {
    console.log(`No listener service is installed for profile "${name}". Install one with \`${NPX} listen service install\`.`);
    process.exitCode = 1;
    return;
  }
  try {
    if (process.platform === "linux") systemctl("status", unitName(name), "--no-pager");
    else run("launchctl", ["print", `${launchdTarget()}/${launchdLabel(name)}`]);
  } catch {
    process.exitCode = 1;
  }
}
