import { NPX } from "../listen/version.ts";
import type { ConnectionView } from "./api.ts";

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

export const validSlug = (s: string) => /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(s);

/** How to reconnect it: the console link when the API gives one, and the CLI command. */
export function reconnectHint(c: Pick<ConnectionView, "slug" | "reconnectUrl">): string {
  return `Reconnect: ${c.reconnectUrl ? `${c.reconnectUrl}  or  ` : ""}${NPX} connections reconnect ${c.slug}`;
}
