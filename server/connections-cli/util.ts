import { NPX } from "../listen/version.ts";

/** A connection slug (`[a-z0-9-]{1,24}`, like the presets') from a client's server name or a host. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return s || "server";
}

export const validSlug = (s: string) => /^[a-z0-9-]{1,24}$/.test(s);

/** How to reconnect it later. */
export function reconnectHint(c: { slug: string }): string {
  return `Reconnect: ${NPX} connections reconnect ${c.slug}   (or Connections → Reconnect in the console)`;
}
