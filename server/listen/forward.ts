import type { WebhookPayload } from "../../shared/types.ts";
import { newSecret, sign } from "../webhooks/send.ts";
import { describeFetchError, userAgent } from "./api.ts";
import { isLoopbackHost } from "./transport.ts";

export { newSecret };

export interface ForwardResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  response: string | null;
  durationMs: number;
}

/** Forward targets must be on this machine: the point is waking a local process, not relaying mail elsewhere. */
export function validateForwardUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --forward URL "${raw}". Use e.g. http://localhost:8787/agentinbox.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--forward must be an http(s) URL.");
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`--forward must point at this machine (localhost, 127.0.0.1 or [::1]), not ${url.host}. For remote receivers, use a webhook in the agentinbox console.`);
  }
  if (url.username || url.password) throw new Error("--forward must not contain credentials; receivers verify the signature instead.");
  return url.toString();
}

/**
 * POSTs the WebhookPayload exactly like a daemon webhook (Standard Webhooks headers, signed with the
 * listener's own secret), so the same receiver code works for both. webhook-id is the event id and
 * stays the same across retries: dedupe on it. Redirects are not followed.
 */
export async function forwardEvent(url: string, secret: string, payload: WebhookPayload, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ForwardResult> {
  const started = performance.now();
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const id = payload.data.id;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      headers: {
        "content-type": "application/json",
        "user-agent": userAgent(),
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": sign(secret, id, timestamp, body),
      },
      body,
    });
    const text = (await res.text().catch(() => "")).slice(0, 500) || null;
    const ok = res.status >= 200 && res.status < 300;
    return { ok, statusCode: res.status, response: text, error: ok ? null : `Receiver responded ${res.status}`, durationMs: elapsed() };
  } catch (err) {
    const reason = timeout.aborted ? `Timed out after ${Math.round(opts.timeoutMs / 1000)} s` : describeFetchError(err);
    return { ok: false, statusCode: null, response: null, error: reason, durationMs: elapsed() };
  }
}
