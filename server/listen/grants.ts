import type { AgentSelf } from "../../shared/agent-api.ts";
import { safeText } from "./ui.ts";

type Grant = AgentSelf["grants"][number];

/**
 * A grant in plain words, e.g. "ops@acme.dev: read, draft, send; sends need your approval in the
 * console". Uses the same wording as the console's approval choices (Read only, Read and draft,
 * Send with my approval, Full access) so the human recognizes what they picked. Calendar access is
 * described after the mail part.
 */
export function describeGrant(g: Grant): string {
  const all = g.capabilities;
  const caps = all.filter((c) => !c.startsWith("calendar."));
  const parts: string[] = [];
  const readOnly = caps.length === 1 && caps[0] === "read";
  if (readOnly) parts.push(all.length > 1 ? `${all.join(", ")}; mail read only (can't draft or send)` : "read only (can't draft or send)");
  else parts.push(all.join(", ") || "no capabilities");
  if (caps.includes("send")) {
    if (g.sendMode === "approval") parts.push("sends need your approval in the console");
    else if (g.sendMode === "direct") parts.push(g.allowTo?.length ? "sends go out directly to allowed recipients" : "sends go out directly");
    else parts.push("sends become Gmail drafts for you to send");
    // Restrictions the daemon enforces on top of the send mode.
    if (g.allowTo?.length) {
      const shown = g.allowTo.slice(0, 3).map((a) => safeText(a, 80));
      parts.push(`only to ${shown.join(", ")}${g.allowTo.length > 3 ? ` and ${g.allowTo.length - 3} more` : ""}`);
    }
    if (g.replyOnly) parts.push("replies in existing threads only");
    const limits = [g.maxSendsPerHour ? `${g.maxSendsPerHour}/hour` : null, g.maxSendsPerDay ? `${g.maxSendsPerDay}/day` : null].filter(Boolean);
    if (limits.length) parts.push(`at most ${limits.join(", ")}`);
  } else if (!readOnly && caps.length) {
    parts.push("can't send");
  }
  if (g.labelScope?.length) parts.push(`only label${g.labelScope.length > 1 ? "s" : ""} ${g.labelScope.map((l) => safeText(l, 60)).join(", ")}`);
  if (all.includes("calendar.write")) {
    // Older daemons don't report the mode; new grants default to approval.
    parts.push(g.calendarWriteMode === "direct" ? "calendar changes apply directly" : "calendar changes need your approval in the console");
  }
  if (g.calendarScope?.length && all.some((c) => c.startsWith("calendar."))) {
    parts.push(`only calendar${g.calendarScope.length > 1 ? "s" : ""} ${g.calendarScope.map((c) => safeText(c, 80)).join(", ")}`);
  }
  return `${safeText(g.accountEmail || g.accountId, 120)}: ${parts.join("; ")}`;
}

/** One line per grant, or a hint when there are none. */
export function describeGrants(grants: Grant[]): string[] {
  if (!grants.length) return ["no mailbox or calendar access yet: add a grant for this agent in the console (Agents page)"];
  return grants.map(describeGrant);
}

/** Stable key for "did the grants change?" (order-independent). */
export const grantsKey = (grants: Grant[]) =>
  JSON.stringify(
    grants
      .map((g) => [
        g.accountId,
        [...g.capabilities].sort(),
        g.sendMode,
        g.labelScope ? [...g.labelScope].sort() : null,
        g.allowTo ? [...g.allowTo].sort() : null,
        g.replyOnly ?? null,
        g.maxSendsPerHour ?? null,
        g.maxSendsPerDay ?? null,
        g.calendarScope ? [...g.calendarScope].sort() : null,
        g.calendarWriteMode ?? null,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
