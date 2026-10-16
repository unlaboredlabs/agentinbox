import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The product name, and the one it had before (agentinbox → xaq). Installs from before the rename keep
 * working: their environment variables, data directory, services and agent-side names are still found.
 */
export const PRODUCT = "xaq";
export const LEGACY_PRODUCT = "agentinbox";

/**
 * `XAQ_<name>`, else the pre-rename `AGENTINBOX_<name>`. A set `XAQ_` variable wins even when empty
 * (an empty value is how some settings are switched off).
 */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[`XAQ_${name}`];
  return value !== undefined ? value : env[`AGENTINBOX_${name}`];
}

/** Whether this process runs under `service install` (XAQ_SERVICE=1; AGENTINBOX_SERVICE=1 in units from before the rename). */
export const underService = (env: NodeJS.ProcessEnv = process.env) => envVar("SERVICE", env) === "1";

/**
 * What pickDir chose: `xaq` holding our files (or not there yet), the pre-rename `agentinbox`, or a `xaq`
 * that another program owns, which we share by only adding our own paths to it.
 */
export type DirKind = "ours" | "legacy" | "shared";

/**
 * Our directory under `base` (an XDG base directory, or the home directory with `dot`). Another, unrelated
 * program is also called xaq and may own a `xaq` directory there (`~/.config/xaq` with its credentials and
 * history), so a `xaq` directory counts as ours only when it holds one of `markers`, paths only we create
 * there. That is checked with a stat: nothing in it is read.
 * 1. `xaq` when it holds a marker: ours (also what nightly.71/72 set up);
 * 2. `agentinbox` (from before the rename) when it exists;
 * 3. else `xaq`: ours when it doesn't exist yet; when it belongs to the other program ("shared"), we only add
 *    our own paths beside its files, and never change, rename or delete anything we didn't create.
 * Nothing is ever moved.
 */
export function pickDir(base: string, markers: string[], opts: { dot?: boolean } = {}): { dir: string; kind: DirKind } {
  const name = (n: string) => join(base, opts.dot ? `.${n}` : n);
  const next = name(PRODUCT);
  if (markers.some((m) => isPresent(join(next, m)))) return { dir: next, kind: "ours" };
  const legacy = name(LEGACY_PRODUCT);
  if (existsSync(legacy)) return { dir: legacy, kind: "legacy" };
  return { dir: next, kind: isPresent(next) ? "shared" : "ours" };
}

/** A stat, nothing more (no symlink is followed into reading anything). */
function isPresent(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
