import { HttpError } from "../util/errors.ts";
import { AccountNeedsReauthError, GoogleApiError, type GoogleErrorDetails } from "./types.ts";

/** Attempts per request (first try included) for 429, 5xx, 403 rate limits and network errors. */
export const MAX_ATTEMPTS = 5;

export type Query = Record<string, string | number | boolean | string[] | null | undefined>;

export function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(base.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Resolves after `ms`, or early (without throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Exponential backoff with jitter; honors Retry-After when Google sends one. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 60_000);
  const base = Math.min(32_000, 500 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Builds a GoogleApiError from a JSON API error (`{error:{code,message,status,errors,details}}`) or an OAuth error. */
export function googleErrorFromBody(status: number, body: unknown, fallback: string, retryAfterMs?: number): GoogleApiError {
  const details: GoogleErrorDetails = { reasons: [], retryAfterMs };
  let message = fallback;
  let reason: string | null = null;
  if (isObj(body) && isObj(body.error)) {
    const e = body.error;
    message = str(e.message) ?? message;
    details.status = str(e.status);
    const errors = Array.isArray(e.errors) ? e.errors.filter(isObj) : [];
    for (const item of errors) if (str(item.reason)) details.reasons!.push(item.reason as string);
    const extra = Array.isArray(e.details) ? e.details.filter(isObj) : [];
    let infoReason: string | undefined;
    for (const d of extra) {
      const type = str(d["@type"]) ?? "";
      if (type.endsWith("ErrorInfo")) {
        infoReason = str(d.reason);
        if (infoReason) details.reasons!.push(infoReason);
        if (isObj(d.metadata)) {
          details.metadata = Object.fromEntries(Object.entries(d.metadata).map(([k, v]) => [k, String(v)]));
        }
      }
      if (type.endsWith("PreconditionFailure") && Array.isArray(d.violations)) {
        for (const v of d.violations.filter(isObj)) if (str(v.type)) details.reasons!.push(v.type as string);
      }
    }
    reason = infoReason ?? str(errors[0]?.reason) ?? details.status ?? null;
  } else if (isObj(body) && str(body.error)) {
    // OAuth endpoints: { error: "invalid_grant", error_description: "…" }
    details.status = body.error as string;
    details.reasons!.push(body.error as string);
    reason = body.error as string;
    message = str(body.error_description) ?? (body.error as string);
  }
  return new GoogleApiError(status, message, reason, details);
}

export async function errorFromResponse(res: Response): Promise<GoogleApiError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON error page.
  }
  const fallback = `Google API returned HTTP ${res.status}${text && !body ? `: ${text.slice(0, 200)}` : ""}`;
  return googleErrorFromBody(res.status, body, fallback, parseRetryAfter(res.headers.get("retry-after")));
}

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);

export function isRetryable(err: GoogleApiError): boolean {
  if (err.status === 0 || err.status === 429 || err.status >= 500) return true;
  return err.status === 403 && (err.details.reasons ?? []).some((r) => RATE_REASONS.has(r));
}

export function hasReason(err: GoogleApiError, ...reasons: string[]): boolean {
  const all = [err.reason, err.details.status, ...(err.details.reasons ?? [])];
  return reasons.some((r) => all.includes(r));
}

export const isAbortError = (err: unknown): boolean =>
  err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

/**
 * Per-account token bucket for Gmail's per-user quota (250 units/second). Callers await `take(cost)`
 * before each request; waiters are served in order.
 */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity = 250,
    private readonly perSecond = 250,
  ) {
    this.tokens = capacity;
  }

  take(cost: number): Promise<void> {
    if (cost <= 0) return Promise.resolve();
    const n = Math.min(cost, this.capacity);
    const next = this.queue.then(async () => {
      this.refill();
      if (this.tokens < n) {
        await sleep(((n - this.tokens) / this.perSecond) * 1000);
        this.refill();
      }
      this.tokens -= n;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private refill(): void {
    const t = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
  }
}

/** Maps Google-side failures to console API errors; anything else passes through unchanged. */
export function asHttpError(err: unknown): unknown {
  if (err instanceof AccountNeedsReauthError) {
    return new HttpError(409, "needs_reauth", err.message, "Reconnect the account on the Accounts page.");
  }
  if (err instanceof GoogleApiError) {
    if (err.status === 404) return new HttpError(404, "not_found", `Gmail says: ${err.message}`);
    return new HttpError(502, "google_error", `Google API error: ${err.message}`, isRetryable(err) ? "Google is busy or unreachable; retry in a minute." : undefined);
  }
  return err;
}
