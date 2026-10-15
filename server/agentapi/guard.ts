import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hostname as osHostname, networkInterfaces } from "node:os";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../context.ts";
import type { AgentApiEnv } from "./auth.ts";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::"]);
const INTERFACES_TTL_MS = 30_000;
const TAILSCALE_TTL_MS = 5 * 60_000;
const RESOLVE_TTL_MS = 60_000;

let interfaceCache: { at: number; addrs: Set<string> } | null = null;

/** IP addresses of this machine's interfaces (LAN, Tailscale, …), cached briefly. */
function localAddresses(): Set<string> {
  const t = Date.now();
  if (!interfaceCache || t - interfaceCache.at > INTERFACES_TTL_MS) {
    const addrs = new Set<string>();
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) addrs.add(a.address.replace(/%.*$/, "").toLowerCase());
    interfaceCache = { at: t, addrs };
  }
  return interfaceCache.addrs;
}

/** The hostname part of a Host header value ("[::1]:8425" → "::1"), lowercased; null if unparsable. */
export function hostOf(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

export interface HostDeps {
  /** This machine's Tailscale MagicDNS name ("box.tailnet.ts.net"), or null. */
  tailscaleName: () => Promise<string | null>;
  /** All addresses a name resolves to. */
  resolve: (host: string) => Promise<string[]>;
}

let tailscaleCache: { at: number; name: Promise<string | null> } | null = null;

/** `tailscale status --json` → Self.DNSName, cached; null when Tailscale isn't installed or running. */
function tailscaleName(): Promise<string | null> {
  const t = Date.now();
  if (!tailscaleCache || t - tailscaleCache.at > TAILSCALE_TTL_MS) {
    const name = new Promise<string | null>((resolve) => {
      execFile("tailscale", ["status", "--json", "--peers=false"], { timeout: 2000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const dns = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName;
          resolve(dns ? dns.replace(/\.$/, "").toLowerCase() : null);
        } catch {
          resolve(null);
        }
      });
    });
    tailscaleCache = { at: t, name };
  }
  return tailscaleCache.name;
}

const resolveCache = new Map<string, { at: number; addrs: Promise<string[]> }>();

function resolveCached(host: string): Promise<string[]> {
  const t = Date.now();
  const hit = resolveCache.get(host);
  if (hit && t - hit.at < RESOLVE_TTL_MS) return hit.addrs;
  const addrs = dnsLookup(host, { all: true }).then(
    (list) => list.map((a) => a.address.toLowerCase()),
    () => [],
  );
  resolveCache.set(host, { at: t, addrs });
  if (resolveCache.size > 100) resolveCache.delete(resolveCache.keys().next().value!);
  return addrs;
}

const DEFAULT_DEPS: HostDeps = { tailscaleName, resolve: resolveCached };

/**
 * Host names this daemon answers to on /agent/v1: the public URL's host, loopback names, the bound
 * host, this machine's hostname, IP literals of local interfaces, and this machine's Tailscale
 * name (`tailscale status`; failing that, a `*.ts.net` name that resolves only to local interface
 * addresses). Anything else (a foreign name resolving here, as in DNS rebinding) is refused.
 */
export async function hostAllowed(ctx: AppContext, host: string, deps: HostDeps = DEFAULT_DEPS): Promise<boolean> {
  if (hostAllowedSync(ctx, host)) return true;
  if (!host.endsWith(".ts.net")) return false;
  if ((await deps.tailscaleName()) === host) return true;
  const addrs = await deps.resolve(host);
  const local = localAddresses();
  return addrs.length > 0 && addrs.every((a) => local.has(a));
}

function hostAllowedSync(ctx: AppContext, host: string): boolean {
  if (LOOPBACK_NAMES.has(host) || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host === hostOf(new URL(ctx.settings.publicUrl()).host)) return true;
  const bound = ctx.config.host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!WILDCARD_HOSTS.has(bound) && host === bound) return true;
  const machine = osHostname().toLowerCase();
  if (host === machine || host === `${machine}.local`) return true;
  return isIP(host) !== 0 && localAddresses().has(host);
}

const apiError = (code: string, message: string, hint?: string) => ({ error: { code, message, ...(hint ? { hint } : {}) } });

/**
 * Browser and rebinding guard for /agent/v1. The CLI never sends Origin or Sec-Fetch-* headers and
 * always posts JSON, so a request from a web page (cross-site, or same-origin after DNS rebinding)
 * is refused before it can start a pairing, read a device code or spend this address's limits.
 */
export function agentRequestGuard(ctx: AppContext, deps?: HostDeps): MiddlewareHandler<AgentApiEnv> {
  return async (c, next) => {
    if (c.req.header("origin") !== undefined || c.req.header("sec-fetch-site") !== undefined) {
      return c.json(apiError("browser_request", "The agent API does not accept browser requests", "Use `npx agentinbox-cli connect` / `listen`."), 403);
    }
    const host = hostOf(c.req.header("host") ?? new URL(c.req.url).host);
    if (!host || !(await hostAllowed(ctx, host, deps))) {
      return c.json(
        apiError("unknown_host", "This agentinbox does not answer to that host name", "Use the public URL configured in Settings (behind a proxy, forward the original Host header)."),
        421,
      );
    }
    if (c.req.method === "POST" && !/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) {
      return c.json(apiError("unsupported_media_type", "Send the request body as application/json"), 415);
    }
    await next();
  };
}
