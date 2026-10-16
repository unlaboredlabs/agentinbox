// Relative (not @shared): unit tests load this file under the server config.
import { type CalendarWriteMode, type Grant, type GrantInput, isCalendarCapability, type MAIL_CAPABILITIES, type SendMode } from "../../shared/types.ts";

type MailCapability = (typeof MAIL_CAPABILITIES)[number];

/**
 * A grant's settings without the account it applies to (the account is the URL/context). Unlike GrantInput
 * the calendar fields are required: the console always sends them, so what is saved is what was shown.
 */
export type GrantFields = Omit<GrantInput, "accountId" | "calendarScope" | "calendarWriteMode"> & Pick<Grant, "calendarScope" | "calendarWriteMode">;

export const DEFAULT_GRANT: GrantFields = {
  capabilities: ["read", "draft", "send"],
  labelScope: null,
  sendMode: "draft_only",
  allowTo: [],
  replyOnly: false,
  maxSendsPerHour: null,
  maxSendsPerDay: null,
  calendarScope: null,
  calendarWriteMode: "approval",
};

/** A mail access preset. Calendar access is set separately and survives switching presets (presetGrant). */
export interface GrantPreset {
  id: string;
  label: string;
  description: string;
  capabilities: MailCapability[];
  sendMode: SendMode;
}

export const GRANT_PRESETS: GrantPreset[] = [
  {
    id: "drafts",
    label: "Read and draft (recommended)",
    description: "Reads mail; anything it sends becomes a Gmail draft for you to review and send.",
    capabilities: ["read", "draft", "send"],
    sendMode: "draft_only",
  },
  {
    id: "read",
    label: "Read only",
    description: "Search and read mail, and receive events. Can't draft, send or change anything.",
    capabilities: ["read"],
    sendMode: "draft_only",
  },
  {
    id: "approval",
    label: "Send with my approval",
    description: "Reads and organizes mail; each send waits in Approvals until you approve it.",
    capabilities: ["read", "draft", "send", "organize"],
    sendMode: "approval",
  },
  {
    id: "full",
    label: "Full access",
    description: "Reads, organizes, trashes and sends directly. Only for agents you fully trust.",
    capabilities: ["read", "draft", "send", "organize", "trash"],
    sendMode: "direct",
  },
];

/**
 * The grant for a preset. Presets only cover mail: the calendar capabilities and fields of `from` (the
 * grant being edited) are kept, so picking "Full access" never drops calendar access set before.
 */
export function presetGrant(p: GrantPreset, from: GrantFields = DEFAULT_GRANT): GrantFields {
  return {
    ...DEFAULT_GRANT,
    capabilities: [...p.capabilities, ...from.capabilities.filter(isCalendarCapability)],
    sendMode: p.sendMode,
    calendarScope: from.calendarScope,
    calendarWriteMode: from.calendarWriteMode,
  };
}

export function toGrantFields(g: Grant): GrantFields {
  return {
    capabilities: g.capabilities,
    labelScope: g.labelScope,
    sendMode: g.sendMode,
    allowTo: g.allowTo,
    replyOnly: g.replyOnly,
    maxSendsPerHour: g.maxSendsPerHour,
    maxSendsPerDay: g.maxSendsPerDay,
    calendarScope: g.calendarScope,
    calendarWriteMode: g.calendarWriteMode,
  };
}

/** The PUT/POST body for a grant on `accountId`, every field explicit. */
export const grantInput = (accountId: string, g: GrantFields): GrantInput & GrantFields => ({ ...g, accountId });

/**
 * The grant editor's calendar write control: "none" is the absence of calendar.write (the write mode is
 * kept, so turning writes back on restores it).
 */
export type CalendarWriteChoice = "none" | CalendarWriteMode;

export const calendarWriteChoice = (g: Pick<GrantFields, "capabilities" | "calendarWriteMode">): CalendarWriteChoice =>
  g.capabilities.includes("calendar.write") ? g.calendarWriteMode : "none";

export function withCalendarWriteChoice(g: Pick<GrantFields, "capabilities" | "calendarWriteMode">, choice: CalendarWriteChoice) {
  const others = g.capabilities.filter((c) => c !== "calendar.write");
  return choice === "none"
    ? { capabilities: others, calendarWriteMode: g.calendarWriteMode }
    : { capabilities: [...others, "calendar.write" as const], calendarWriteMode: choice };
}

export const hasCalendarAccess = (g: Pick<GrantFields, "capabilities">) => g.capabilities.some(isCalendarCapability);

/** Exact address ("bob@example.com") or glob ("*@example.com", "*@*.example.com"). */
export function validateAddressGlob(v: string): string | null {
  if (/\s/.test(v)) return "no spaces allowed";
  const at = v.split("@");
  if (at.length !== 2 || !at[0] || !at[1]) return "use name@domain or *@domain";
  if (!/^[a-z0-9*][a-z0-9.*-]*\.[a-z*]{2,}$/i.test(at[1]) && at[1] !== "*") return "the domain doesn't look right";
  return null;
}

export const sameGrant = (a: GrantFields, b: GrantFields) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

function normalize(g: GrantFields): GrantFields {
  return {
    ...g,
    capabilities: [...g.capabilities].sort(),
    labelScope: g.labelScope ? [...g.labelScope].sort() : null,
    allowTo: [...g.allowTo].sort(),
    calendarScope: g.calendarScope ? [...g.calendarScope].sort() : null,
  };
}

/** Why a grant can't be saved as it is, or null. */
export function grantProblem(g: GrantFields): string | null {
  if (!g.capabilities.length) return "Choose at least one capability.";
  if (g.labelScope && g.labelScope.length === 0) return "Pick at least one label, or allow the whole mailbox.";
  if (hasCalendarAccess(g) && g.calendarScope && g.calendarScope.length === 0) return "Pick at least one calendar, or allow every calendar.";
  if (g.maxSendsPerHour === 0 || g.maxSendsPerDay === 0) return "Send limits must be at least 1 (leave empty for no limit).";
  return null;
}
