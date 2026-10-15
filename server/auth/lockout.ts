import { sha256 } from "../crypto.ts";

export const MAX_FAILURES = 5;
export const BAN_MS = 15 * 60_000;

interface Entry {
  tried: Set<string>;
  since: number;
  bannedUntil: number;
}

/**
 * Failed-login limiter per client IP: 5 distinct wrong secrets within 15 minutes ban the address
 * for 15 minutes. Each distinct secret counts once, so a client retrying the same stale password
 * (or several tabs doing so at once) can't spend every attempt.
 */
export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Minutes until the ban ends, or 0 when the address may try. */
  bannedMinutes(ip: string): number {
    const entry = this.entries.get(ip);
    const left = entry ? entry.bannedUntil - this.clock() : 0;
    return left > 0 ? Math.ceil(left / 60_000) : 0;
  }

  /** Records a failure; returns true when this failure started a ban. */
  fail(ip: string, secret: string): boolean {
    const t = this.clock();
    const entry = this.entries.get(ip);
    const fresh = entry && !entry.bannedUntil && t - entry.since < BAN_MS;
    const tried = fresh ? entry.tried : new Set<string>();
    tried.add(sha256(secret));
    const banned = tried.size >= MAX_FAILURES;
    this.entries.set(ip, { tried, since: fresh ? entry.since : t, bannedUntil: banned ? t + BAN_MS : 0 });
    this.sweep(t);
    return banned;
  }

  clear(ip: string): void {
    this.entries.delete(ip);
  }

  /** Bounds memory under a spray of addresses. */
  private sweep(t: number): void {
    if (this.entries.size < 1000) return;
    for (const [ip, e] of this.entries) {
      if (e.bannedUntil < t && t - e.since >= BAN_MS) this.entries.delete(ip);
    }
  }
}
