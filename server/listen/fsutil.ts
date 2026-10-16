import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Creates a directory (and parents) readable only by this user. Tightens an existing one. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * Writes a file with mode 0600 atomically (temp file + rename), so a crash never leaves a
 * half-written profile and the secret is never briefly world-readable.
 */
export function writePrivateFile(linkOrPath: string, content: string, opts: { privateDir?: boolean } = {}): void {
  // A symlinked config (dotfiles repos) is updated at its real location instead of being replaced by a plain file.
  const path = resolveLink(linkOrPath);
  if (opts.privateDir !== false) ensurePrivateDir(dirname(path));
  else mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function resolveLink(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/** Copies `path` next to itself as `<path>.xaq-backup-<timestamp>` (0600). Returns the copy, or null if there was nothing to back up. */
export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const content = readFileSync(path);
  // Created 0600 and exclusively (never through an existing file or symlink), then filled.
  for (let n = 0; ; n++) {
    const backup = `${path}.xaq-backup-${stamp}${n ? `-${n}` : ""}`;
    try {
      writeFileSync(backup, content, { mode: 0o600, flag: "wx" });
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 20) throw err;
    }
  }
}

/** Tightens an existing file to 0600 (files created by appendFileSync keep their first mode). */
export function tighten(path: string): void {
  if (process.platform !== "win32" && existsSync(path) && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
}

/**
 * A directory commands may run in: must exist, be owned by this user and not be writable by group or
 * others (otherwise someone else could plant agent instructions, MCP configs or hooks there).
 */
export function assertTrustedDir(dir: string): string {
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new Error(`--cwd ${dir} does not exist.`);
  }
  if (!st.isDirectory()) throw new Error(`--cwd ${dir} is not a directory.`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`Refusing --cwd ${dir}: it belongs to another user, who could plant instructions or hooks for the agent there.`);
  if (process.platform !== "win32" && (st.mode & 0o022) !== 0) {
    throw new Error(`Refusing --cwd ${dir}: it is writable by group or others (mode ${(st.mode & 0o777).toString(8)}). Use a directory only you can write to.`);
  }
  // A parent others can write to (without the sticky bit) lets them swap this directory out.
  for (let p = dirname(dir); p !== dirname(p); p = dirname(p)) {
    try {
      const ps = statSync(p);
      if (process.platform !== "win32" && (ps.mode & 0o022) !== 0 && (ps.mode & 0o1000) === 0) {
        process.stderr.write(`warning: --cwd ${dir}: its parent ${p} is writable by group or others, so they could replace it.\n`);
        break;
      }
    } catch {
      break;
    }
  }
  return dir;
}

/** True when group or others can read/write the file. */
export const isTooOpen = (path: string) => process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0;
