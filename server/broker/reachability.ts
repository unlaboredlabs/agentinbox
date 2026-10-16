// Can a provider (WHOOP) reach this install's webhook URL from the internet? An https public URL isn't enough: most
// self-hosted installs sit behind Tailscale `serve` on an https *.ts.net name that only the tailnet can reach. This
// classifies the URL as public, private or unknown from the host, its DNS answers and, for *.ts.net, the local
// Tailscale serve config; it never calls a third-party prober. Native presets poll unless webhooks are proven
// to arrive (broker service), so a wrong answer here only hides or shows an optional setup step.
//
// Tailscale Funnel (https://tailscale.com/kb/1311/tailscale-funnel, https://tailscale.com/kb/1242/tailscale-serve):
// `tailscale funnel [--bg] [--https=<port>] [--set-path=<path>] <target>`, ports 443, 8443 or 10000 only, and
// `tailscale serve status --json` prints the raw ipn.ServeConfig (`Web` keyed "host:port" → `Handlers` keyed by
// mount point, `AllowFunnel` keyed "host:port"; both commands share the status subcommand). Funnel exposes a whole
// port, so the offer uses its own port and mounts only CONNECTION_HOOKS_PREFIX there: tailscaled matches a request
// to the longest mount point (path.Dir walk; no handler at "/" means 404) and strips the mount before proxying to
// the target, whose path is kept (ipnlocal.getServeHandler, serveWebHandler; ipn.ExpandProxyTargetValue), so
// /hooks/connections/<id> reaches the daemon as /hooks/connections/<id> and nothing else on the port is served.
// The daemon never changes the Tailscale config: it only shows the command.

import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { CONNECTION_HOOKS_PREFIX } from "../integrations/hooks.ts";
import { type LookupFn, isBlockedAddress, normalizeIp, urlHost } from "../webhooks/ssrf.ts";

export type Reach = "public" | "private" | "unknown";

/** A Tailscale CLI run: its stdout, and the binary that answered (shown in the offered command). */
export type TailscaleRunner = (args: string[]) => Promise<{ bin: string; stdout: string } | null>;

export interface ReachabilityDeps {
  lookup: LookupFn;
  /** null when the CLI is missing, not running, or fails: never an error. */
  tailscale: TailscaleRunner;
}

/** The optional Funnel step: exposes only the webhook path, on a port the console doesn't use. */
export interface FunnelOffer {
  port: number;
  /** The webhook origin once the command has run (`https://<host>:<port>`). */
  origin: string;
  command: string;
  offCommand: string;
}

export interface WebhookReachability {
  reach: Reach;
  /** Where providers can deliver webhooks (the public URL, or a detected Funnel of the hooks path); null: poll only. */
  webhookBase: string | null;
  /** Offered when the URL is a *.ts.net name, the Tailscale CLI answers and nothing public serves the hooks path. */
  funnel: FunnelOffer | null;
  /** Why, in a few words (logs and tests). */
  reason: string;
}

export const FUNNEL_PORTS = [8443, 10000, 443] as const;
const DNS_TIMEOUT_MS = 2000;
const TAILSCALE_TIMEOUT_MS = 2000;
/** Long enough not to run the CLI per request, short enough that running the Funnel command shows up soon. */
export const REACHABILITY_TTL_MS = 60_000;

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp", ".private"];

/** From the host alone: null when it needs DNS (an ordinary name). */
export function classifyHost(host: string): Exclude<Reach, "unknown"> | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isIP(h)) return isBlockedAddress(h) ? "private" : "public";
  if (h === "localhost" || !h.includes(".") || PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return "private";
  return null;
}

/** Every answer private, CGNAT (Tailscale's 100.64/10, MagicDNS) or loopback: private; any public one: public. */
export async function classifyByDns(host: string, lookup: LookupFn, timeoutMs = DNS_TIMEOUT_MS): Promise<Reach> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const answers = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    if (!answers.length) return "unknown";
    return answers.some((a) => !isBlockedAddress(normalizeIp(a.address))) ? "public" : "private";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
}

/** The config with its foreground (non --bg) sessions folded in. */
function flatten(c: ServeConfig): Required<Omit<ServeConfig, "Foreground">> {
  const out = { TCP: { ...c.TCP }, Web: { ...c.Web }, AllowFunnel: { ...c.AllowFunnel } };
  for (const f of Object.values(c.Foreground ?? {})) {
    Object.assign(out.TCP, f.TCP);
    Object.assign(out.Web, f.Web);
    Object.assign(out.AllowFunnel, f.AllowFunnel);
  }
  return out;
}

const hookMounts = new Set([CONNECTION_HOOKS_PREFIX, `${CONNECTION_HOOKS_PREFIX}/`]);
const originFor = (host: string, port: number) => (port === 443 ? `https://${host}` : `https://${host}:${port}`);
const portOf = (url: URL) => (url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80);

/** The funnelled port whose hooks mount proxies to this daemon's hooks path, if any. */
function funnelledHooksPort(c: ReturnType<typeof flatten>, host: string, target: string): number | null {
  for (const port of FUNNEL_PORTS) {
    const key = `${host}:${port}`;
    if (!c.AllowFunnel[key]) continue;
    const handlers = c.Web[key]?.Handlers ?? {};
    if (Object.entries(handlers).some(([mount, h]) => hookMounts.has(mount) && h?.Proxy?.replace(/\/+$/, "") === target)) return port;
  }
  return null;
}

/**
 * Classifies `publicUrl` for inbound webhooks. `localOrigin` is where the daemon listens (loopbackUrl), the
 * target of the offered Funnel command. Never throws: a missing CLI or a failed lookup is just less information.
 */
export async function checkWebhookReachability(publicUrl: string, localOrigin: string, deps: ReachabilityDeps): Promise<WebhookReachability> {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return { reach: "unknown", webhookBase: null, funnel: null, reason: "unparsable public URL" };
  }
  const host = urlHost(url).toLowerCase().replace(/\.$/, "");
  const https = url.protocol === "https:";
  const base = (reach: Reach, reason: string, funnel: FunnelOffer | null = null): WebhookReachability => ({
    reach,
    // WHOOP only delivers to https.
    webhookBase: reach === "public" && https ? publicUrl.replace(/\/+$/, "") : null,
    funnel,
    reason,
  });

  const byHost = classifyHost(host);
  if (byHost) return base(byHost, byHost === "private" ? "private host" : "public IP");
  if (!host.endsWith(".ts.net")) return base(await classifyByDns(host, deps.lookup), "DNS");

  // *.ts.net: MagicDNS answers 100.x on this machine even with Funnel on, so the serve config decides.
  const [dns, ts] = await Promise.all([classifyByDns(host, deps.lookup), deps.tailscale(["serve", "status", "--json"]).catch(() => null)]);
  let config: ReturnType<typeof flatten> | null = null;
  try {
    config = ts ? flatten((JSON.parse(ts.stdout || "{}") as ServeConfig | null) ?? {}) : null;
  } catch {
    config = null;
  }
  if (!config) return base(dns, "ts.net without the Tailscale CLI: DNS");
  if (config.AllowFunnel[`${host}:${portOf(url)}`]) return base("public", "Tailscale Funnel on the public URL's port");
  const target = `${localOrigin.replace(/\/+$/, "")}${CONNECTION_HOOKS_PREFIX}`;
  const funnelled = funnelledHooksPort(config, host, target);
  if (funnelled !== null) {
    return { reach: "private", webhookBase: originFor(host, funnelled), funnel: null, reason: "Tailscale Funnel on the hooks path only" };
  }
  // A port nothing else serves on (TCP lists every serve port, the console's included).
  const busy = new Set([portOf(url), ...Object.keys(config.TCP).map(Number)]);
  const port = FUNNEL_PORTS.find((p) => !busy.has(p));
  if (port === undefined) return base("private", "tailnet only; every Funnel port is in use");
  const bin = ts!.bin;
  const flags = `--https=${port} --set-path=${CONNECTION_HOOKS_PREFIX}`;
  return base("private", "tailnet only (Tailscale serve, no Funnel)", {
    port,
    origin: originFor(host, port),
    command: `${bin} funnel --bg ${flags} ${target}`,
    offCommand: `${bin} funnel ${flags} off`,
  });
}

const TAILSCALE_BINS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** Read-only CLI calls: argv only (no shell), short timeout, the macOS app's binary as a fallback. */
export const runTailscale: TailscaleRunner = async (args) => {
  for (const bin of TAILSCALE_BINS) {
    const stdout = await new Promise<string | null>((resolve) => {
      execFile(bin, args, { timeout: TAILSCALE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, out) => resolve(err ? null : out));
    });
    if (stdout !== null) return { bin, stdout };
  }
  return null;
};

export const DEFAULT_REACHABILITY_DEPS: ReachabilityDeps = {
  lookup: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  tailscale: runTailscale,
};

export interface ReachabilityCache {
  /** The last answer for the current public URL ("unknown" until the first check finishes); starts a check when stale. */
  current(): WebhookReachability;
  /** A fresh-enough answer: awaits a running or new check (bounded by the lookup and CLI timeouts). */
  check(): Promise<WebhookReachability>;
}

const UNKNOWN: WebhookReachability = { reach: "unknown", webhookBase: null, funnel: null, reason: "not checked yet" };

/** Cached per public URL; nothing runs until asked, so startup never waits on DNS or the CLI. */
export function reachabilityCache(opts: {
  publicUrl: () => string;
  localOrigin: () => string;
  deps?: Partial<ReachabilityDeps>;
  now?: () => number;
  ttlMs?: number;
}): ReachabilityCache {
  const deps: ReachabilityDeps = { ...DEFAULT_REACHABILITY_DEPS, ...opts.deps };
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? REACHABILITY_TTL_MS;
  let entry: { key: string; at: number; value: WebhookReachability | null; running: Promise<WebhookReachability> | null } | null = null;

  const refresh = (): Promise<WebhookReachability> => {
    const key = `${opts.publicUrl()}\n${opts.localOrigin()}`;
    if (entry?.key !== key) entry = { key, at: 0, value: null, running: null };
    const e = entry;
    if (e.value && now() - e.at < ttl) return Promise.resolve(e.value);
    if (!e.running) {
      e.running = checkWebhookReachability(opts.publicUrl(), opts.localOrigin(), deps)
        .catch(() => UNKNOWN)
        .then((v) => {
          e.value = v;
          e.at = now();
          e.running = null;
          return v;
        });
    }
    return e.running;
  };

  return {
    current() {
      void refresh();
      return entry?.value ?? UNKNOWN;
    },
    check: refresh,
  };
}
