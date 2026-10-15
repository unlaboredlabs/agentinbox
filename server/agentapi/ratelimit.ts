import type { Context } from "hono";

export interface Take {
  ok: boolean;
  /** True for the first refusal in a window, so callers can audit a flood once instead of per request. */
  firstDenial: boolean;
  /** Seconds until the oldest counted hit leaves the window. */
  retryAfter: number;
}

/** Sliding-window counter per key (client IP): at most `limit` hits per `windowMs`. In memory. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly denied = new Set<string>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Counts a hit unless the key is over the limit (refused hits are not counted). */
  take(key: string): Take {
    const t = this.clock();
    const recent = (this.hits.get(key) ?? []).filter((ts) => t - ts < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const firstDenial = !this.denied.has(key);
      this.denied.add(key);
      return { ok: false, firstDenial, retryAfter: Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    this.denied.delete(key);
    this.sweep(t);
    return { ok: true, firstDenial: false, retryAfter: 0 };
  }

  /** Bounds memory under a spray of addresses. */
  private sweep(t: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, list] of this.hits) {
      if (!list.length || t - list.at(-1)! >= this.windowMs) {
        this.hits.delete(key);
        this.denied.delete(key);
      }
    }
  }
}

/** 429 with Retry-After and an ApiError body. */
export function tooManyRequests(c: Context, code: string, message: string, retryAfter: number, hint?: string): Response {
  c.header("Retry-After", String(retryAfter));
  return c.json({ error: { code, message, ...(hint ? { hint } : {}) } }, 429);
}
