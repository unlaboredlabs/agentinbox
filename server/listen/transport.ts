import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import pc from "picocolors";

/**
 * Transport rule for `connect` and `listen`: the API key travels in every request, so plain http is
 * only accepted where the network itself is private and encrypted.
 *
 *  - https://…                                     always
 *  - http:// to loopback                           localhost, 127.0.0.0/8, ::1, or a *.localhost name that
 *                                                  resolves only to loopback addresses
 *  - http:// to Tailscale                          100.64.0.0/10 and fd7a:115c:a1e0::/48 (WireGuard-encrypted
 *                                                  tailnet), or a MagicDNS name (*.ts.net) that resolves only to
 *                                                  those ranges. The name is resolved and checked, so a public DNS
 *                                                  record under ts.net can't smuggle in a non-tailnet address.
 *  - anything else over http                       refused unless --insecure (loud warning on every start)
 *
 * 100.64.0.0/10 is also the carrier-grade NAT range; it is accepted because Tailscale owns it on any
 * machine running Tailscale, which is the case this exception exists for.
 */

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const tailnet = new BlockList();
tailnet.addSubnet("100.64.0.0", 10, "ipv4");
tailnet.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

const family = (ip: string) => (isIP(ip) === 6 ? "ipv6" : "ipv4");
const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();

/** localhost or a loopback IP literal. `*.localhost` names are only trusted after resolving (see checkTransport). */
export const isLoopbackHost = (host: string): boolean => {
  const h = bare(host);
  if (h === "localhost") return true;
  return isLoopbackIp(h);
};

const isLoopbackIp = (ip: string) => {
  const h = bare(ip);
  return isIP(h) !== 0 && loopback.check(h, family(h));
};

export const isTailnetIp = (ip: string) => isIP(ip) !== 0 && tailnet.check(bare(ip), family(bare(ip)));

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type TransportVerdict = { ok: true; kind: "https" | "loopback" | "tailscale" | "insecure"; warning?: string };

export class TransportError extends Error {}

/** Parses and normalizes a daemon URL: origin plus path, no trailing slash, no credentials. */
export function normalizeDaemonUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new TransportError(`Invalid daemon URL "${raw}". Use a full URL such as https://mail.example.com.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TransportError("The daemon URL must start with http:// or https://");
  if (url.username || url.password) throw new TransportError("The daemon URL must not contain credentials.");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

export async function checkTransport(rawUrl: string, opts: { insecure?: boolean; resolve?: Resolver } = {}): Promise<TransportVerdict> {
  const url = new URL(rawUrl);
  if (url.protocol === "https:") return { ok: true, kind: "https" };
  const host = bare(url.hostname);
  if (isLoopbackHost(host)) return { ok: true, kind: "loopback" };
  if (isTailnetIp(host)) return { ok: true, kind: "tailscale" };
  // Names are checked by what they resolve to right now. The listener re-checks before every
  // reconnect and ack, so a record that later changes is caught (only a race inside one connect remains).
  if (host.endsWith(".localhost") || host.endsWith(".ts.net")) {
    const addresses = await (opts.resolve ?? defaultResolver)(host).catch(() => [] as string[]);
    const want = host.endsWith(".localhost") ? isLoopbackIp : isTailnetIp;
    if (addresses.length && addresses.every(want)) return { ok: true, kind: host.endsWith(".localhost") ? "loopback" : "tailscale" };
  }
  if (opts.insecure) {
    return {
      ok: true,
      kind: "insecure",
      warning: `INSECURE: talking to ${url.host} over plain http. The agent's API key and every email event cross the network unencrypted and can be read or altered by anyone on the path. Use https or Tailscale.`,
    };
  }
  throw new TransportError(
    `Refusing plain http to ${url.host}: the API key would cross the network unencrypted.\n` +
      `  Use https://, a loopback address, or a Tailscale address (100.64.0.0/10 or a *.ts.net name).\n` +
      `  To accept the risk anyway (e.g. an isolated lab network), add --insecure.`,
  );
}

/** The loud, unmissable banner printed on every start in insecure mode. */
export function insecureBanner(warning: string): string {
  const line = "!".repeat(78);
  return `${pc.red(line)}\n${pc.red(pc.bold(`  ${warning}`))}\n${pc.red(line)}`;
}
