// How a code extension's child is started (docs/EXTENSIONS.md "The code-extension host"): the exact argv, the
// environment built from nothing, and the per-connection state directory.
//
// The flags were checked on Node 22.13.0 and 24.22 (CI runs both): `--permission` is stable on both, and each allowed
// path is its own `--allow-fs-read=` / `--allow-fs-write=` flag. The comma form (`--allow-fs-read=a,b`) is read as one
// literal path on both versions, so it must never come back (test/extension-host.test.ts pins the argv). Without
// `--allow-child-process`, `--allow-worker`, `--allow-addons` and `--allow-wasi`, those are all refused.

import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Bumped only with a protocol change C and the extensions repo agree on. */
export const XAQ_EXT_PROTOCOL = "1";

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `<dataDir>/extension-state/<name>/<connectionId>/`. Throws on a name or id that isn't a plain path segment. */
export function extensionStateDir(dataDir: string, name: string, connectionId: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid extension name: ${name.slice(0, 40)}`);
  if (!ID_RE.test(connectionId)) throw new Error("Invalid connection id");
  return join(resolve(dataDir), "extension-state", name, connectionId);
}

/**
 * Creates the state directory (and its parents) as 0700, owned by xaq. An existing one must be a real directory (not
 * a symlink) or nothing starts.
 */
export function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(stateDir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("The extension's state directory isn't a plain directory");
  if ((st.mode & 0o077) !== 0) {
    // Created before with a looser mode (by hand, or another umask): tighten it.
    chmodSync(stateDir, 0o700);
  }
}

/** Deletes the connection's state under every extension (on connection removal). Never follows a symlink out. */
export function removeConnectionState(dataDir: string, connectionId: string): void {
  if (!ID_RE.test(connectionId)) return;
  const root = join(resolve(dataDir), "extension-state");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const dir = join(root, name, connectionId);
    try {
      lstatSync(dir);
    } catch {
      continue;
    }
    // rmSync never follows symlinks inside the tree; the directory itself is ours (lstat'ed above).
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `<installDir>/<entry>`, refused unless it's a regular file inside the install. */
export function entryPath(installDir: string, entry: string): string {
  const root = resolve(installDir);
  const full = resolve(root, entry);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error("The extension's entry is outside its install directory");
  const st = lstatSync(full);
  if (!st.isFile()) throw new Error("The extension's entry isn't a regular file (symlinks are refused)");
  return full;
}

/**
 * The child's argv after the Node binary. Exactly: `--permission`, one read allow for the install and one for the
 * state directory, one write allow for the state directory, then the entry. Nothing else.
 */
export function childArgs(installDir: string, stateDir: string, entry: string): string[] {
  return ["--permission", `--allow-fs-read=${resolve(installDir)}`, `--allow-fs-read=${resolve(stateDir)}`, `--allow-fs-write=${resolve(stateDir)}`, entry];
}

/**
 * The child's whole environment, built from nothing: the four XAQ_EXT_* values, plus TZ and LANG when xaq has them.
 * No PATH, HOME, NODE_OPTIONS, XAQ_*, AGENTINBOX_* or anything else from xaq's environment.
 */
export function childEnv(p: { name: string; connectionId: string; stateDir: string }, from: { TZ?: string; LANG?: string } = process.env): Record<string, string> {
  const env: Record<string, string> = {
    XAQ_EXT_NAME: p.name,
    XAQ_EXT_CONNECTION_ID: p.connectionId,
    XAQ_EXT_STATE_DIR: resolve(p.stateDir),
    XAQ_EXT_PROTOCOL,
  };
  if (from.TZ) env.TZ = from.TZ;
  if (from.LANG) env.LANG = from.LANG;
  return env;
}
