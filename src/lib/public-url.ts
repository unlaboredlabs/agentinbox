// What a public URL means for the two things that depend on it: Google sign-in (the OAuth redirect)
// and agents (the transport rule in src/lib/cli.ts, the same one the CLI enforces).

import { type Transport, transportOf } from "./cli";

export type HostKind = "loopback" | "tailscale" | "ip" | "private-name" | "public-name";

function ipv4(host: string) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : null;
}

// Names Google won't accept in a redirect URI: they don't end in a public top-level domain.
const PRIVATE_SUFFIXES = [".lan", ".local", ".home", ".internal", ".home.arpa", ".localdomain", ".corp", ".intranet", ".private", ".test", ".example", ".invalid", ".localhost"];

export function hostKind(url: URL): HostKind {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const t = transportOf(url.href);
  if (t === "loopback") return "loopback";
  if (t === "tailscale" && !host.endsWith(".ts.net")) return "tailscale";
  if (ipv4(host) || host.includes(":")) return "ip";
  if (!host.includes(".") || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return "private-name";
  return "public-name";
}

export interface UrlAnalysis {
  url: URL;
  transport: Transport;
  host: HostKind;
  /**
   * Google sign-in: "direct" redirects back here; "paste" means Google can't redirect to plain http,
   * so the user pastes the address they land on; "rejected" is https Google won't accept (raw IP or a
   * private name).
   */
  google: "direct" | "paste" | "rejected";
}

export function analyzeUrl(raw: string): UrlAnalysis | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const transport = transportOf(url.href);
  const host = hostKind(url);
  const google =
    host === "loopback" ? "direct" : url.protocol === "http:" ? "paste" : host === "ip" || host === "private-name" ? "rejected" : "direct";
  return { url, transport, host, google };
}

/** Short label for an address chip ("This machine", "Your network", …). */
export function addressLabel(raw: string, browserOrigin: string): string {
  const a = analyzeUrl(raw);
  if (!a) return "Address";
  if (raw === browserOrigin && a.host !== "loopback") return "Address in your browser";
  switch (a.host) {
    case "loopback":
      return raw === browserOrigin ? "This computer (your browser's address)" : "This computer only";
    case "tailscale":
      return "Tailscale";
    case "ip": {
      const v4 = ipv4(a.url.hostname);
      const priv = v4 && (v4[0] === 10 || (v4[0] === 172 && v4[1]! >= 16 && v4[1]! <= 31) || (v4[0] === 192 && v4[1] === 168) || (v4[0] === 169 && v4[1] === 254));
      return priv ? "Your local network" : "Public IP";
    }
    default:
      return "Network name";
  }
}

export const isLoopbackOrigin = (origin: string) => analyzeUrl(origin)?.host === "loopback";

/** The port this console is served on (for tunnel and Tailscale commands). */
export function consolePort(addresses: string[], publicUrl: string): string {
  // The server's own addresses first: the browser may reach it through a tunnel or proxy on another port.
  for (const u of [...addresses, window.location.origin, publicUrl]) {
    try {
      const p = new URL(u).port;
      if (p) return p;
    } catch {
      /* skip */
    }
  }
  return "8425";
}

// Mirrors the server's validation (server/settings.ts) so mistakes show before saving.
export function publicUrlError(v: string): string | undefined {
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    return "Enter a full URL, e.g. https://mail.example.com or http://localhost:8425";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Use http or https.";
  if (url.search || url.hash) return "Leave out any ?query or #fragment.";
  return undefined;
}

