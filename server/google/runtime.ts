import type { GmailLabel } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { errorMessage } from "../util/errors.ts";
import { backoffMs, buildUrl, errorFromResponse, isAbortError, isRetryable, MAX_ATTEMPTS, type Query, sleep, TokenBucket } from "./http.ts";
import { TokenManager } from "./tokens.ts";
import { GoogleApiError } from "./types.ts";

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Gmail quota units charged to the account's token bucket (0 = not throttled, e.g. Pub/Sub). */
  cost?: number;
  signal?: AbortSignal;
}

/**
 * Per-context shared state for server/google and server/ingest: token manager, quota buckets, label
 * cache and Pub/Sub test waiters. Keyed by the AppContext so every service sees the same instance.
 */
export class GoogleRuntime {
  readonly tokens: TokenManager;
  readonly labelCache = new Map<string, { at: number; labels: GmailLabel[] }>();
  /** Pub/Sub test-message nonces → resolver (resolved by whichever pull sees the message). */
  readonly pubsubTests = new Map<string, () => void>();
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(ctx: AppContext) {
    this.tokens = new TokenManager(ctx);
  }

  /**
   * Authenticated JSON request as `accountId`. Throttles by quota cost, retries 429/5xx/403 rate
   * limits and network errors with backoff, refreshes the token once on 401.
   */
  async request<T>(accountId: string, base: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = buildUrl(base, path, opts.query);
    const method = opts.method ?? "GET";
    let forced = false;
    for (let attempt = 0; ; attempt++) {
      if (opts.cost) await this.bucket(accountId).take(opts.cost);
      const token = await this.tokens.accessToken(accountId, { force: forced });
      let err: GoogleApiError;
      try {
        const res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: opts.signal,
        });
        if (res.ok) {
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
        err = await errorFromResponse(res);
      } catch (e) {
        if (isAbortError(e)) throw e;
        if (e instanceof SyntaxError) throw new GoogleApiError(502, "Google returned an invalid JSON response", "invalid_response");
        err = new GoogleApiError(0, `Could not reach Google (${new URL(url).host}): ${errorMessage(e)}`, "network");
      }
      if (err.status === 401 && !forced) {
        forced = true;
        this.tokens.invalidate(accountId);
        continue;
      }
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS - 1) throw err;
      await sleep(backoffMs(attempt, err.details.retryAfterMs), opts.signal);
      if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  }

  private bucket(accountId: string): TokenBucket {
    let b = this.buckets.get(accountId);
    if (!b) this.buckets.set(accountId, (b = new TokenBucket()));
    return b;
  }
}

const runtimes = new WeakMap<object, GoogleRuntime>();

export function googleRuntime(ctx: AppContext): GoogleRuntime {
  let r = runtimes.get(ctx);
  if (!r) runtimes.set(ctx, (r = new GoogleRuntime(ctx)));
  return r;
}
