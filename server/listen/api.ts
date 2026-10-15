import { hostname } from "node:os";
import type { AgentSelf, PairingPoll, PairingStart, PairingStartInput } from "../../shared/agent-api.ts";
import { version } from "./version.ts";

/** Identifies the client to the daemon (shown on the agent's Listeners list). Never includes the key. */
export const userAgent = () => `agentinbox/${version} (${process.platform}; ${hostname()})`;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly hint: string | null = null,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/** Turns a non-2xx response into an ApiError, using the `{ error: { code, message, hint } }` body when present. */
export async function apiError(res: Response, what: string): Promise<ApiError> {
  let code: string | null = null;
  let message = `${what} failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  let hint: string | null = null;
  try {
    const text = await res.text();
    const body = JSON.parse(text) as { error?: { code?: string; message?: string; hint?: string } };
    if (body.error?.message) message = body.error.message;
    code = body.error?.code ?? null;
    hint = body.error?.hint ?? null;
  } catch {
    // Not JSON: keep the generic message.
  }
  const ra = Number(res.headers.get("retry-after"));
  return new ApiError(message, res.status, code, hint, Number.isFinite(ra) && ra > 0 ? ra : null);
}

async function call<T>(base: string, path: string, init: RequestInit & { key?: string; timeoutMs?: number }, what: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": userAgent() };
  if (init.body) headers["content-type"] = "application/json";
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers, redirect: "error", signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  } catch (err) {
    throw new ApiError(`${what} failed: could not reach ${base} (${describeFetchError(err)})`, 0);
  }
  if (!res.ok) throw await apiError(res, what);
  return (await res.json()) as T;
}

export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError") return "timed out";
  if (err.name === "AbortError") return "aborted";
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code === "ECONNREFUSED") return "connection refused";
  if (cause?.code === "ENOTFOUND") return "host not found";
  if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ""}`;
  return cause?.message ?? err.message;
}

export const startPairing = (base: string, input: PairingStartInput) =>
  call<PairingStart>(base, "/agent/v1/pairings", { method: "POST", body: JSON.stringify(input) }, "Starting the pairing");

export const pollPairing = (base: string, deviceCode: string) =>
  call<PairingPoll>(base, "/agent/v1/pairings/poll", { method: "POST", body: JSON.stringify({ deviceCode }) }, "Checking the pairing");

export const getSelf = (base: string, key: string, timeoutMs = 10_000) => call<AgentSelf>(base, "/agent/v1/me", { method: "GET", key, timeoutMs }, "Checking the key");

export const ackEvents = (base: string, key: string, consumer: string, seq: number) =>
  call<{ ackedSeq: number }>(base, "/agent/v1/events/ack", { method: "POST", key, body: JSON.stringify({ consumer, seq }) }, "Acknowledging events");
