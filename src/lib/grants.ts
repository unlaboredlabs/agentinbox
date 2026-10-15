import type { Capability, Grant, GrantInput, SendMode } from "@shared/types";

/** A grant's settings without the account it applies to (the account is the URL/context). */
export type GrantFields = Omit<GrantInput, "accountId">;

export const DEFAULT_GRANT: GrantFields = {
  capabilities: ["read", "draft", "send"],
  labelScope: null,
  sendMode: "draft_only",
  allowTo: [],
  replyOnly: false,
  maxSendsPerHour: null,
  maxSendsPerDay: null,
};

export interface GrantPreset {
  id: string;
  label: string;
  description: string;
  capabilities: Capability[];
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

export function presetGrant(p: GrantPreset): GrantFields {
  return { ...DEFAULT_GRANT, capabilities: [...p.capabilities], sendMode: p.sendMode };
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
  };
}

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
  };
}

/** Why a grant can't be saved as it is, or null. */
export function grantProblem(g: GrantFields): string | null {
  if (!g.capabilities.length) return "Choose at least one capability.";
  if (g.labelScope && g.labelScope.length === 0) return "Pick at least one label, or allow the whole mailbox.";
  if (g.maxSendsPerHour === 0 || g.maxSendsPerDay === 0) return "Send limits must be at least 1 (leave empty for no limit).";
  return null;
}
