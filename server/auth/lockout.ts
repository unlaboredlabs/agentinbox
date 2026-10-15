import { isIPv6 } from "node:net";
import { sha256 } from "../crypto.ts";

/** Distinct wrong secrets per client within the window before a ban. */
export const MAX_FAILURES = 5;
/** Raw failed attempts per client within the window (repeats of the same wrong secret included). */
export const MAX_ATTEMPTS = 30;
/** Distinct wrong secrets across all clients within the window before every attempt is slowed down. */
export const GLOBAL_MAX_FAILURES = 100;
/** Delay per attempt while the global budget is exceeded. */
export const GLOBAL_SLOWDOWN_MS = 2000;
export const WINDOW_MS = 15 * 60_000;
export const BAN_MS = 15 * 60_000;
/** Tracked clients; the least recently seen is dropped beyond this. */
export const MAX_ENTRIES = 10_000;

interface Entry {
  tried: Set<string>;
  attempts: number;
  since: number;
  bannedUntil: number;
}

/**
 * Failed sign-in limiter. Per client (IPv4 address or IPv6 /64): 5 distinct wrong secrets or 30
 * attempts within 15 minutes ban it for 15 minutes. A secret already known to be wrong is
 * rejected without hashing (`knownBad`) and counts only as an attempt, so a client retrying a stale
 * password can't spend every attempt, and can't make the server hash it again either. Past a global
 * budget of distinct failures, every attempt is slowed down (never refused, so many clients can't
 * lock the owner out).
 */
export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();
  private global = { failures: 0, since: 0 };

  constructor(private readonly clock: () => number = Date.now) {}

  /** Minutes until this client may try again, or 0. */
  bannedMinutes(ip: string): number {
    const t = this.clock();
    const entry = this.entries.get(clientKey(ip));
    const until = entry && entry.bannedUntil > t ? entry.bannedUntil : 0;
    return until > t ? Math.ceil((until - t) / 60_000) : 0;
  }

  /** The global failure budget is exhausted: slow every attempt down. */
  overGlobalBudget(): boolean {
    return this.global.failures >= GLOBAL_MAX_FAILURES && this.clock() - this.global.since < WINDOW_MS;
  }

  /** The client already failed with exactly this secret in the current window. */
  knownBad(ip: string, secret: string): boolean {
    const entry = this.current(clientKey(ip), this.clock());
    return !!entry?.tried.has(sha256(secret));
  }

  /** Records a failure; returns true when it started a ban for this client. `global: false` keeps it out of the global budget. */
  fail(ip: string, secret: string, opts: { global?: boolean } = {}): boolean {
    return this.record(ip, secret, opts).banned;
  }

  /**
   * Counts an attempt with this secret now, before it is verified, so concurrent requests can't
   * all pass the ban check first. `countedGlobally` says whether it used global budget (refund it
   * with `refundGlobal` when the secret turns out to be right).
   */
  record(ip: string, secret: string, opts: { global?: boolean } = {}): { banned: boolean; countedGlobally: boolean } {
    const t = this.clock();
    const key = clientKey(ip);
    const entry = this.current(key, t) ?? { tried: new Set<string>(), attempts: 0, since: t, bannedUntil: 0 };
    const hash = sha256(secret);
    let countedGlobally = false;
    if (!entry.tried.has(hash)) {
      entry.tried.add(hash);
      if (opts.global !== false) {
        if (t - this.global.since >= WINDOW_MS) this.global = { failures: 0, since: t };
        this.global.failures++;
        countedGlobally = true;
      }
    }
    entry.attempts++;
    const banned = entry.tried.size >= MAX_FAILURES || entry.attempts >= MAX_ATTEMPTS;
    if (banned) entry.bannedUntil = t + BAN_MS;
    this.touch(key, entry);
    return { banned, countedGlobally };
  }

  refundGlobal(): void {
    if (this.global.failures > 0) this.global.failures--;
  }

  clear(ip: string): void {
    this.entries.delete(clientKey(ip));
  }

  /** After the password changes, previously wrong secrets may be right. */
  reset(): void {
    this.entries.clear();
    this.global = { failures: 0, since: 0 };
  }

  get size(): number {
    return this.entries.size;
  }

  /** The client's entry if its window (or ban) is still running. */
  private current(key: string, t: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.bannedUntil > t || (!entry.bannedUntil && t - entry.since < WINDOW_MS)) return entry;
    this.entries.delete(key);
    return undefined;
  }

  /** Map order doubles as LRU order: re-insert on use, evict from the front. */
  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** IPv4 addresses as is (also when IPv4-mapped); IPv6 by /64, since one client usually owns the whole prefix. */
export function clientKey(ip: string): string {
  const addr = ip.replace(/%.*$/, "").toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1]!;
  if (!isIPv6(addr)) return addr;
  const [head = "", tail] = addr.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
