// Presets whose server the user names (IntegrationPreset.userServer: T3 Code). Shared by the connections API and the
// CLI; the console mirrors these in src/components/connections/connection-flow.ts (presetServerUrl, presetServerSlug).

import { validateUpstreamUrl } from "../broker/upstream/fetch.ts";

/**
 * The MCP URL for a user-named server: the URL as given, with the preset's MCP path when only an origin was given
 * (`http://100.104.249.49:3773` → `http://100.104.249.49:3773/mcp`). Throws SourceError on a URL the upstream guard
 * would refuse outright (not http(s), userinfo).
 */
export function presetServerUrl(raw: string, defaultPath: string): string {
  const u = validateUpstreamUrl(raw.trim());
  if (u.pathname === "/" || u.pathname === "") u.pathname = defaultPath;
  return u.toString();
}

/** A slug part naming a host: an IP's digits with dashes, else its first DNS label (forge.tail1.ts.net → forge). */
export function hostSlugPart(url: string): string {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const part = /^[\d.]+$/.test(host) || host.includes(":") ? host : (host.split(".")[0] ?? host);
  return part.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The default slug for a user-named server: `<preset slug>-<host>`, at most 24 characters (t3-100-104-249-49). */
export function presetServerSlug(presetSlug: string, url: string): string {
  return `${presetSlug}-${hostSlugPart(url)}`.slice(0, 24).replace(/-+$/, "");
}
