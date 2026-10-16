// Pure (relative imports only, no React): unit tests load it.

import type { AccessLevel, ConnectionView, PairingRequest } from "../../../shared/types.ts";
import type { GrantFields } from "../../lib/grants.ts";
import { CAPABILITY_INFO, SEND_MODE_INFO } from "../../lib/labels.ts";

/**
 * A connection's starting level on the pairing card: the card's choices are all a paired agent gets, so only an
 * "All agents" connection starts with access (its default level); every other one starts at No access.
 */
export const pairingConnectionDefault = (c: Pick<ConnectionView, "allAgents" | "levelDefault">): AccessLevel | "none" => (c.allAgents ? c.levelDefault : "none");

/**
 * What a new pairing starts with, regardless of what the agent asked for: mail read only, no calendar,
 * and calendar writes set to ask first should the human add them.
 */
export const PAIRING_DEFAULT: GrantFields = {
  capabilities: ["read"],
  labelScope: null,
  sendMode: "draft_only",
  allowTo: [],
  replyOnly: false,
  maxSendsPerHour: null,
  maxSendsPerDay: null,
  calendarScope: null,
  calendarWriteMode: "approval",
};

/** What the request asks for beyond read + draft-only (calendar access included; direct calendar writes named). */
export function asksForMore(p: Pick<PairingRequest, "requested">): string[] {
  const more: string[] = [];
  const caps = p.requested.capabilities ?? [];
  for (const c of caps) if (c !== "read" && c !== "draft") more.push(CAPABILITY_INFO[c].label);
  if (p.requested.sendMode && p.requested.sendMode !== "draft_only") more.push(SEND_MODE_INFO[p.requested.sendMode].label);
  if (caps.includes("calendar.write") && p.requested.calendarWriteMode === "direct") more.push("Calendar writes: Direct");
  return more;
}
