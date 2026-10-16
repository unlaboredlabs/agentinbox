import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { type LookupFn, resolveTarget, type ResolvedTarget, SsrfError, type TargetMessages } from "../../webhooks/ssrf.ts";
import { SourceError } from "../types.ts";

/**
 * The broker's one outbound fetch for upstream MCP servers and their OAuth endpoints (docs/MCP-BROKER.md,
 * "Outbound fetch is pinned and SSRF-guarded"):
 * - every hop is checked with the webhook guard `resolveTarget` and the connection is pinned to the checked
 *   address (an undici Agent whose `connect.lookup` only ever answers that address: no DNS rebinding);
 * - redirects are manual, re-checked at every hop, at most MAX_REDIRECTS; credentials are dropped when a
 *   redirect leaves the origin;
 * - response bodies are capped (`maxBytes`), streamed bodies included.
 *
 * Private targets are refused unless the connection has a private-target allow (`PrivateTargetAllow`): it
 * is pinned to one exact origin and unlocks loopback, RFC 1918, CGNAT and ULA there, plus plain http on
 * that origin only. Link-local and cloud metadata stay blocked (resolveTarget refuses metadata unless the
 * exact IP is listed, and these CIDRs never list it).
 */

/** Admin-set allow for one connection: the exact `scheme://host:port` the admin entered (normalised origin). */
export interface PrivateTargetAllow {
  origin: string;
}

/** Ranges the private-target allow unlocks. Never link-local (169.254/16, fe80::/10) or metadata. */
export const PRIVATE_ALLOW_CIDRS: readonly string[] = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
];

export const MAX_REDIRECTS = 3;
/** Default response cap: MCP results are text; 16 MiB is far beyond any sane tool result. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** `scheme://host:port` with the default port made explicit, so `http://h` and `http://h:80` compare equal. */
export function originKey(url: URL | string): string {
  const u = typeof url === "string" ? new URL(url) : url;
  const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
}

/** Validates and normalises an admin-entered origin for a PrivateTargetAllow. Throws on anything else. */
export function privateAllowFor(url: string): PrivateTargetAllow {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("A private-target allow needs an http or https URL");
  if (u.username || u.password) throw new Error("A private-target allow can't carry credentials");
  return { origin: originKey(u) };
}

const messages = (allowed: boolean): TargetMessages => ({
  subject: "Upstream URL",
  allowHint: () =>
    allowed
      ? "Only loopback, private (RFC 1918), CGNAT and unique-local addresses can be allowed; link-local and cloud metadata never are."
      : "If this is a server on this machine or your private network, the admin can allow this exact host for this connection.",
  httpHint: allowed
    ? "Plain http is only accepted when the allowed host resolves to a private address."
    : "Plain http is only accepted on a connection's own allowed private host.",
  hostHint: "Check the hostname in the connection's URL.",
});

export interface GuardedFetchOptions {
  allow?: PrivateTargetAllow | null;
  /** DNS resolver (tests). */
  lookup?: LookupFn;
  maxBytes?: number;
}

export type GuardedFetch = ((input: string | URL, init?: RequestInit) => Promise<Response>) & {
  /** Closes the pooled pinned connections. */
  close(): Promise<void>;
};

/** Checks one URL against the guard (no request). Throws SourceError("blocked_target"). */
export async function checkTarget(url: URL, opts: GuardedFetchOptions = {}): Promise<ResolvedTarget> {
  if (url.username || url.password) throw new SourceError("blocked_target", "Upstream URLs can't carry credentials");
  const allowed = !!opts.allow && originKey(url) === opts.allow.origin;
  try {
    return await resolveTarget(url, allowed ? PRIVATE_ALLOW_CIDRS : [], opts.lookup, messages(allowed));
  } catch (err) {
    if (err instanceof SsrfError) {
      if (err.kind === "dns") throw new SourceError("unavailable", err.message);
      throw new SourceError("blocked_target", err.hint ? `${err.message}. ${err.hint}` : err.message);
    }
    throw err;
  }
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** A body stream that errors once more than `max` bytes have passed. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new SourceError("protocol", `Upstream response exceeded ${max} bytes`));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** Builds the guarded fetch for one connection. */
export function guardedFetch(opts: GuardedFetchOptions = {}): GuardedFetch {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const agents = new Map<string, Agent>();

  const agentFor = (url: URL, target: ResolvedTarget): Agent => {
    const key = `${originKey(url)}|${target.address}`;
    let agent = agents.get(key);
    if (!agent) {
      const lookup: LookupFunction = (_hostname, options, cb) => {
        if (options.all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      };
      agent = new Agent({ connect: { lookup }, keepAliveTimeout: 30_000 });
      if (agents.size >= 16) {
        const [oldKey, old] = agents.entries().next().value as [string, Agent];
        agents.delete(oldKey);
        void old.close().catch(() => {});
      }
      agents.set(key, agent);
    }
    return agent;
  };

  const run = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    let url = new URL(String(input));
    const startOrigin = originKey(url);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body ?? null;
    const headers = new Headers(init.headers);
    for (let hop = 0; ; hop++) {
      const target = await checkTarget(url, opts);
      // undici's own fetch and Agent (the global fetch may come from another undici version).
      const res = await undiciFetch(url, {
        method,
        headers: headers as never,
        body: body as never,
        redirect: "manual",
        signal: init.signal ?? undefined,
        dispatcher: agentFor(url, target),
      });
      if (REDIRECT.has(res.status) && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new SourceError("protocol", `Upstream redirected more than ${MAX_REDIRECTS} times`);
        const next = new URL(res.headers.get("location")!, url);
        if (originKey(next) !== startOrigin) {
          // Never carry credentials to another origin.
          headers.delete("authorization");
          headers.delete("cookie");
          for (const name of [...headers.keys()]) if (name.startsWith("x-api") || name === "api-key") headers.delete(name);
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = null;
          headers.delete("content-type");
          headers.delete("content-length");
        } else if (body !== null && typeof body !== "string" && !(body instanceof URLSearchParams) && !(body instanceof Uint8Array)) {
          throw new SourceError("protocol", "Upstream redirected a streamed request");
        }
        url = next;
        continue;
      }
      const length = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(length) && length > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new SourceError("protocol", `Upstream response is ${length} bytes, over the ${maxBytes}-byte limit`);
      }
      const out = new Response(NULL_BODY.has(res.status) || !res.body ? null : capped(res.body as ReadableStream<Uint8Array>, maxBytes), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers as unknown as Headers,
      });
      Object.defineProperty(out, "url", { value: url.toString() });
      return out;
    }
  };

  return Object.assign(run, {
    async close() {
      const all = [...agents.values()];
      agents.clear();
      await Promise.all(all.map((a) => a.close().catch(() => {})));
    },
  });
}
