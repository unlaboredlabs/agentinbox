import { homedir } from "node:os";
import { join } from "node:path";
import { LEGACY_PRODUCT, pickDir, PRODUCT } from "../brand.ts";

/**
 * Agent-side locations (the machine running `connect` / `listen`, not the daemon). XDG on Linux and
 * macOS alike, so one set of paths works everywhere:
 *   config  $XDG_CONFIG_HOME/xaq  (~/.config/xaq)       profiles/<name>.json (0600)
 *   state   $XDG_STATE_HOME/xaq   (~/.local/state/xaq)  listen/<name>/{listen.log,dead.jsonl,status.json}
 *   data    $XDG_DATA_HOME/xaq    (~/.local/share/xaq)  app/ (stable install the services run)
 * Each one is still the pre-rename `…/agentinbox` while that exists and the `…/xaq` one doesn't: existing
 * profiles, keys, logs and the listener services' install stay where they are. Nothing is moved.
 */

const xdg = (envVar: string, fallback: string) => {
  const v = process.env[envVar];
  // The XDG spec says relative paths are invalid and must be ignored.
  return v && v.startsWith("/") ? v : join(homedir(), fallback);
};

const named = (base: string) => pickDir(join(base, PRODUCT), join(base, LEGACY_PRODUCT)).dir;

export const configDir = () => named(xdg("XDG_CONFIG_HOME", ".config"));
export const stateDir = () => named(xdg("XDG_STATE_HOME", ".local/state"));
export const dataDir = () => named(xdg("XDG_DATA_HOME", ".local/share"));

export const profilesDir = () => join(configDir(), "profiles");
export const profilePath = (name: string) => join(profilesDir(), `${name}.json`);
export const profileStateDir = (name: string) => join(stateDir(), "listen", name);
export const logPath = (name: string) => join(profileStateDir(name), "listen.log");
/** `listen --backfill` and `--dry-run` log separately, so they can run next to the listener without both rotating one file. */
export const oneOffLogPath = (name: string) => join(profileStateDir(name), "one-off.log");
export const deadPath = (name: string) => join(profileStateDir(name), "dead.jsonl");
export const statusPath = (name: string) => join(profileStateDir(name), "status.json");
/** Default working directory for --exec commands: private (0700), so no planted CLAUDE.md, .mcp.json or hooks apply. */
export const workDir = (name: string) => join(profileStateDir(name), "work");
/** The listeners' stable install (shared by all profiles), staged and swapped like the daemon's `<data>/app`. */
export const listenAppDir = () => join(dataDir(), "app");

export const DEFAULT_PROFILE = "default";
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Profile names become file names and service names, so they are kept boring. */
export function validProfileName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!PROFILE_RE.test(n)) {
    throw new Error(`Invalid profile name "${name}": use 1-40 lowercase letters, digits, "-" or "_", starting with a letter or digit.`);
  }
  return n;
}
