import type { AgentSelf } from "../../shared/agent-api.ts";
import { safeText } from "./ui.ts";

type Grant = AgentSelf["grants"][number];

/**
 * A grant in plain words, e.g. "ops@acme.dev: read, draft, send; sends need your approval in the
 * console". Uses the same wording as the console's approval choices (Read only, Read and draft,
 * Send with my approval, Full access) so the human recognizes what they picked.
 */
export function describeGrant(g: Grant): string {
  const caps = g.capabilities;
  const parts: string[] = [];
  const readOnly = caps.length === 1 && caps[0] === "read";
  if (readOnly) parts.push("read only (can't draft or send)");
  else parts.push(caps.join(", ") || "no capabilities");
  if (caps.includes("send")) {
    if (g.sendMode === "approval") parts.push("sends need your approval in the console");
    else if (g.sendMode === "direct") parts.push("sends go out directly");
    else parts.push("sends become Gmail drafts for you to send");
  } else if (!readOnly && caps.length) {
    parts.push("can't send");
  }
  if (g.labelScope?.length) parts.push(`only labels ${g.labelScope.map((l) => safeText(l, 60)).join(", ")}`);
  return `${safeText(g.accountEmail || g.accountId, 120)}: ${parts.join("; ")}`;
}

/** One line per grant, or a hint when there are none. */
export function describeGrants(grants: Grant[]): string[] {
  if (!grants.length) return ["no mailbox access yet: add a grant for this agent in the console (Agents page)"];
  return grants.map(describeGrant);
}

/** Stable key for "did the grants change?" (order-independent). */
export const grantsKey = (grants: Grant[]) =>
  JSON.stringify(
    grants
      .map((g) => [g.accountId, [...g.capabilities].sort(), g.sendMode, g.labelScope ? [...g.labelScope].sort() : null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
