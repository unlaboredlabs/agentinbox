import { networkInterfaces } from "node:os";

/** This machine's IPv4 addresses other clients can reach it at (LAN, VPN, tailnet). */
export function networkAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
}

export const isWildcardHost = (host: string) => host === "0.0.0.0" || host === "::" || host === "";

/** URLs the server is reachable at: localhost first, then LAN addresses when bound to all interfaces. */
export function consoleUrls(host: string, port: number): string[] {
  if (!isWildcardHost(host)) return [`http://${host.includes(":") ? `[${host}]` : host}:${port}`];
  return [`http://localhost:${port}`, ...networkAddresses().map((a) => `http://${a}:${port}`)];
}

/** A URL this machine can use to reach its own server (for health checks after `service install`). */
export function loopbackUrl(host: string, port: number): string {
  if (isWildcardHost(host)) return `http://127.0.0.1:${port}`;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}
