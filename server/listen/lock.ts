import { closeSync, constants, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "./fsutil.ts";
import { profileStateDir } from "./paths.ts";
import { pidAlive } from "./state.ts";
import { NPX } from "./version.ts";

/**
 * One listener per profile: two would share a consumer cursor and run every event twice. The lock is
 * a file with the owner's pid and start time, created exclusively; a lock whose process is gone is
 * stale and taken over.
 */

export const lockPath = (profile: string) => join(profileStateDir(profile), "listen.lock");

interface LockInfo {
  pid: number;
  startedAt: string;
}

export class ProfileLockedError extends Error {
  constructor(
    readonly holder: LockInfo,
    profile: string,
  ) {
    super(
      `Another listener is already running profile "${profile}" (pid ${holder.pid}, since ${holder.startedAt}).\n` +
        `  If it's the background service, check it with \`${NPX} listen service status${profile === "default" ? "" : ` --profile ${profile}`}\`; stop it before running one in the foreground.`,
    );
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return typeof info.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

/** Profiles locked by this process (a second in-process listener has the same pid). */
const held = new Set<string>();

/** Takes the lock or throws ProfileLockedError. Returns a release function (also run on process exit). */
export function acquireProfileLock(profile: string): () => void {
  const path = lockPath(profile);
  ensurePrivateDir(profileStateDir(profile));
  const mine: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
  if (held.has(path)) throw new ProfileLockedError(readLock(path) ?? mine, profile);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeSync(fd, JSON.stringify(mine));
      closeSync(fd);
      held.add(path);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        held.delete(path);
        process.off("exit", release);
        // Only remove it if it is still ours.
        if (readLock(path)?.pid === process.pid) rmSync(path, { force: true });
      };
      process.on("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readLock(path);
    if (holder && holder.pid !== process.pid && pidAlive(holder.pid)) throw new ProfileLockedError(holder, profile);
    // Stale (crashed listener) or unreadable: take it over.
    rmSync(path, { force: true });
  }
  throw new Error(`Could not take the listener lock ${path}.`);
}
