import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
export function writePrivateFile(path: string, content: string, opts: { privateDir?: boolean } = {}): void {
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

/** Copies `path` next to itself as `<path>.agentinbox-backup-<timestamp>` (0600). Returns the copy, or null if there was nothing to back up. */
export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.agentinbox-backup-${stamp}`;
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  return backup;
}

/** True when group or others can read/write the file. */
export const isTooOpen = (path: string) => process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0;
