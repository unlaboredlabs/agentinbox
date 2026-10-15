// Which tool call "Last tool call" shows, as a pure function so it can be tested directly. No React and
// relative imports only (no @ aliases): vitest and the server/test typecheck load this module too.

import type { AuditEntry } from "../../../shared/types.ts";

/** Rejected before the tool ran (see rejectedCall in server/mcp/server.ts), rather than failing in it. */
const REJECTED = new Set(["invalid_arguments", "unknown_tool", "invalid_request"]);

/**
 * The newest successful call of `calls` (newest first), shown with a green tick. With none, the newest
 * call, marked with what went wrong ("rejected: invalid_arguments", "denied: allow_to", "failed:
 * gmail_error") and no tick. Null when there are no calls.
 */
export function lastCallShown(calls: AuditEntry[]): { call: AuditEntry; ok: boolean; note: string | null } | null {
  const ok = calls.find((e) => e.outcome === "ok");
  if (ok) return { call: ok, ok: true, note: null };
  const c = calls[0];
  if (!c) return null;
  const word = c.outcome === "denied" ? "denied" : REJECTED.has(c.reason ?? "") ? "rejected" : "failed";
  return { call: c, ok: false, note: `${word}: ${c.reason ?? "error"}` };
}
