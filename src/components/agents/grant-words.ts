import type { Capability, Grant, SendMode } from "../../../shared/types.ts";

const join = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * A grant in plain words: its mail part, then its calendar part when it has one ("Can read and save
 * drafts; can't send. Can read 2 calendars; writes need your approval"). "Send" with the draft_only mode
 * never reads as sending: it says the agent can save drafts and can't send.
 */
export function grantInWords(g: { capabilities: Capability[]; sendMode: SendMode } & Partial<Pick<Grant, "calendarScope" | "calendarWriteMode">>): string {
  return [mailInWords(g), calendarInWords(g)].filter(Boolean).join(". ") || "No access";
}

/** The mail part alone, null without a mail capability. */
export function mailInWords(g: { capabilities: Capability[]; sendMode: SendMode }): string | null {
  const caps = new Set(g.capabilities);
  const sends = caps.has("send") && g.sendMode !== "draft_only";
  const can: string[] = [];
  if (caps.has("read")) can.push("read");
  if (caps.has("draft") || (caps.has("send") && !sends)) can.push("save drafts");
  if (caps.has("organize")) can.push("organize");
  if (caps.has("trash")) can.push("trash");
  if (sends) can.push(g.sendMode === "approval" ? "send once you approve" : "send");
  if (!can.length) return null;
  if (can.length === 1 && can[0] === "read") return "Can read; can't change or send anything";
  return `Can ${join(can)}${sends ? "" : "; can't send"}`;
}

/**
 * The calendar part alone, null without a calendar capability: "Can read every calendar; can't change
 * events", "Can read 2 calendars; writes need your approval", "Can read and change 1 calendar". Write
 * without read only creates events.
 */
export function calendarInWords(g: { capabilities: Capability[] } & Partial<Pick<Grant, "calendarScope" | "calendarWriteMode">>): string | null {
  const read = g.capabilities.includes("calendar.read");
  const write = g.capabilities.includes("calendar.write");
  if (!read && !write) return null;
  const n = g.calendarScope?.length;
  const which = n === undefined ? "every calendar" : `${n} calendar${n === 1 ? "" : "s"}`;
  const approval = (g.calendarWriteMode ?? "approval") === "approval";
  if (!write) return `Can read ${which}; can't change events`;
  // Changing, deleting or answering an existing event needs calendar.read too (server/calendar/agent.ts).
  if (!read) return `Can create events on ${which}${approval ? " once you approve" : ""}; can't read or change existing ones`;
  return approval ? `Can read ${which}; writes need your approval` : `Can read and change ${which}`;
}
