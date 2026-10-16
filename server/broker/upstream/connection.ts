import type { Db } from "../../db/index.ts";
import { SourceError } from "../types.ts";

/** The columns of `connections` the upstream runtime reads (migration 8). */
export interface ConnectionRow {
  id: string;
  kind: string;
  slug: string;
  name: string;
  url: string | null;
  auth_type: "none" | "header" | "oauth";
  private_target: string | null;
  status: "active" | "needs_reauth" | "error" | "disabled";
  status_reason: string | null;
  preset: string | null;
  expires_at: string | null;
  protocol: string | null;
  protocol_checked_at: string | null;
}

export function getConnection(db: Db, id: string): ConnectionRow | null {
  return db.get<ConnectionRow>("SELECT id, kind, slug, name, url, auth_type, private_target, status, status_reason, preset, expires_at, protocol, protocol_checked_at FROM connections WHERE id = ?", id) ?? null;
}

/** A remote_http connection that can be talked to right now, or a SourceError saying why not. */
export function requireRemote(db: Db, id: string): ConnectionRow & { url: string } {
  const c = getConnection(db, id);
  if (!c) throw new SourceError("unavailable", "This connection no longer exists");
  if (c.kind !== "remote_http" || !c.url) throw new SourceError("unavailable", `${c.name} isn't a remote MCP connection`);
  if (c.status === "disabled") throw new SourceError("unavailable", `${c.name} is disabled`);
  if (c.status === "needs_reauth") {
    throw new SourceError("needs_reauth", `The owner must reconnect ${c.name} in xaq (Connections → Reconnect)${c.status_reason ? `: ${c.status_reason}` : ""}`);
  }
  return c as ConnectionRow & { url: string };
}

/**
 * The negotiated protocol generation as cached in `connections.protocol`: the version string for Streamable
 * HTTP ("2026-07-28" modern, "2025-11-25" etc. legacy) and "sse:<version>" for the legacy HTTP+SSE transport.
 */
export type ProtocolVerdict = { transport: "streamable"; version: string; modern: boolean } | { transport: "sse"; version: string };

export function parseVerdict(s: string | null): ProtocolVerdict | null {
  if (!s) return null;
  if (s.startsWith("sse:")) return { transport: "sse", version: s.slice(4) };
  return { transport: "streamable", version: s, modern: s >= "2026-" };
}

export function formatVerdict(v: ProtocolVerdict): string {
  return v.transport === "sse" ? `sse:${v.version}` : v.version;
}
