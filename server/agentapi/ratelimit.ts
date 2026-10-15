import type { Context } from "hono";

/** Tracked keys per limiter; the least recently used is dropped beyond this. */
export const MAX_KEYS = 10_000;

/** Map order doubles as LRU order: re-insert on use, evict from the front. */
function touch<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}

export interface Take {
  ok: boolean;
  /** True for the first refusal in a window, so callers can audit a flood once instead of per request. */
  firstDenial: boolean;
  /** Seconds until the oldest counted hit leaves the window. */
  retryAfter: number;
}

interface Entry {
  hits: number[];
  denied: boolean;
}

/**
 * Sliding-window counter per key: at most `limit` hits per `windowMs`. In memory, size-capped LRU;
 * each call drops a couple of stale entries from the cold end, so there are no full scans.
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  /** Counts a hit unless the key is over the limit (refused hits are not counted). */
  take(key: string): Take {
    const t = this.clock();
    this.evictStale(t);
    const entry = this.entries.get(key) ?? { hits: [], denied: false };
    entry.hits = entry.hits.filter((ts) => t - ts < this.windowMs);
    let result: Take;
    if (entry.hits.length >= this.limit) {
      result = { ok: false, firstDenial: !entry.denied, retryAfter: Math.max(1, Math.ceil((entry.hits[0]! + this.windowMs - t) / 1000)) };
      entry.denied = true;
    } else {
      entry.hits.push(t);
      entry.denied = false;
      result = { ok: true, firstDenial: false, retryAfter: 0 };
    }
    touch(this.entries, key, entry, this.maxKeys);
    return result;
  }

  get size(): number {
    return this.entries.size;
  }

  private evictStale(t: number): void {
    for (let i = 0; i < 2; i++) {
      const first = this.entries.entries().next().value;
      if (!first || t - (first[1].hits.at(-1) ?? 0) < this.windowMs) return;
      this.entries.delete(first[0]);
    }
  }
}

/** True at most once per key per window: for auditing repeated refusals once. Size-capped LRU. */
export class OncePer {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  first(key: string): boolean {
    const t = this.clock();
    const last = this.seen.get(key);
    if (last !== undefined && t - last < this.windowMs) return false;
    touch(this.seen, key, t, MAX_KEYS);
    return true;
  }
}

/** 429 with Retry-After and an ApiError body. */
export function tooManyRequests(c: Context, code: string, message: string, retryAfter: number, hint?: string): Response {
  c.header("Retry-After", String(retryAfter));
  return c.json({ error: { code, message, ...(hint ? { hint } : {}) } }, 429);
}
