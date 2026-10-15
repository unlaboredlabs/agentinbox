import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { ResolvedTarget } from "./ssrf.ts";

/** Standard Webhooks secret: "whsec_" + base64 of 24 random bytes. */
export const newSecret = (): string => `whsec_${randomBytes(24).toString("base64")}`;
export const secretPrefix = (secret: string): string => secret.slice(0, 12);

/**
 * Standard Webhooks signature (https://www.standardwebhooks.com): base64 HMAC-SHA256 over
 * "{id}.{timestamp}.{body}", keyed with the base64-decoded part of the secret after "whsec_".
 */
export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export interface SendResult {
  statusCode: number | null;
  /** First 500 characters of the response body. */
  response: string | null;
  error: string | null;
  durationMs: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const RESPONSE_CHARS = 500;

/**
 * POSTs the body to `url`, connecting only to the pre-validated `target` address (TLS still
 * verifies the URL's hostname). Never follows redirects and never throws.
 */
export function postPinned(
  url: URL,
  target: ResolvedTarget,
  headers: Record<string, string>,
  body: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<SendResult> {
  const started = performance.now();
  const lookup: LookupFunction = (_hostname, options, cb) => {
    if (options.all) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]) : AbortSignal.timeout(opts.timeoutMs);
  const mod = url.protocol === "https:" ? https : http;

  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const done = (r: Omit<SendResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, durationMs: Math.round(performance.now() - started) });
    };
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        lookup,
        signal,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size < MAX_RESPONSE_BYTES) chunks.push(chunk);
          size += chunk.length;
        });
        res.on("error", (err) => done({ statusCode: res.statusCode ?? null, response: null, error: describe(err, opts.timeoutMs) }));
        res.on("close", () => {
          if (!res.complete) done({ statusCode: res.statusCode ?? null, response: null, error: signal.aborted ? describe(signal.reason as Error, opts.timeoutMs) : "Response was cut off" });
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8").slice(0, RESPONSE_CHARS);
          let error: string | null = null;
          if (status >= 300 && status < 400) {
            const location = res.headers.location;
            error = `Receiver redirected (${status}${location ? ` to ${location}` : ""}); redirects are not followed, point the webhook at the final URL`;
          } else if (status < 200 || status >= 300) {
            error = `Receiver responded ${status}${res.statusMessage ? ` ${res.statusMessage}` : ""}`;
          }
          done({ statusCode: status, response: text || null, error });
        });
      },
    );
    req.on("error", (err) => done({ statusCode: null, response: null, error: describe(err, opts.timeoutMs) }));
    req.end(body);
  });
}

function describe(err: Error, timeoutMs: number): string {
  const code = (err as NodeJS.ErrnoException).code;
  const cause = (err as { cause?: unknown }).cause;
  if (err.name === "AbortError" && cause instanceof Error && cause.name === "TimeoutError") return `Timed out after ${timeoutMs / 1000} s`;
  if (err.name === "TimeoutError") return `Timed out after ${timeoutMs / 1000} s`;
  if (code === "ECONNREFUSED") return "Connection refused";
  if (code === "ECONNRESET") return "Connection reset by the receiver";
  return code ? `${err.message} (${code})` : err.message;
}
