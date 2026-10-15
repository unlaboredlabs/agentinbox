// The SSH tunnel command the console suggests (pure, unit-tested). Mirrors tunnelCommand in
// server/server.ts: forward to localhost unless the server is bound to one specific non-loopback address.

import { shellQuote } from "./cli.ts";

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();
const isLoopback = (h: string) => h === "localhost" || h === "::1" || h.startsWith("127.");

/**
 * @param addresses SystemInfo.addresses: [localhost, …LAN] when bound to all interfaces, else the one bound address.
 * @param browserHost window.location.hostname: the name the user reached the server by (the SSH host).
 */
export function tunnelCommand({ port, addresses, browserHost }: { port: string; addresses: string[]; browserHost: string }): string {
  let target = "localhost";
  if (addresses.length === 1) {
    try {
      const h = bare(new URL(addresses[0]!).hostname);
      if (!isLoopback(h)) target = h;
    } catch {
      /* keep localhost */
    }
  }
  const forward = `${port}:${target.includes(":") ? `[${target}]` : target}:${port}`;
  const host = bare(browserHost);
  const sshHost = host && !isLoopback(host) ? host : "your-server";
  return `ssh -N -L ${shellQuote(forward)} ${shellQuote(`you@${sshHost}`)}`;
}
