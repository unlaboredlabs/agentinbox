import { z } from "zod";
import { EVENT_TYPES, type EventType, type WebhookFilter } from "../../shared/types.ts";
import type { StoredEvent } from "../events/types.ts";
import { matchesAnyGlob } from "../util/glob.ts";

/** Events about the account itself rather than a message: filters only narrow them by account. */
export const ACCOUNT_EVENT_TYPES: readonly EventType[] = ["account.auth_failed", "sync.gap"];

const list = (max: number, label: string) =>
  z
    .array(z.string().trim().min(1, `${label} entries must not be empty`).max(320))
    .max(max, `At most ${max} ${label} entries`)
    .optional();

/** Strict, so a misspelled criterion is an error rather than a filter that silently matches everything. */
export const webhookFilterSchema = z
  .object({
    accountIds: list(100, "account"),
    labelIds: list(100, "label"),
    from: list(100, "from"),
    to: list(100, "to"),
    subject: z
      .string()
      .max(200, "Subject pattern must be at most 200 characters")
      .optional()
      .refine((s) => s === undefined || compiles(s), "Subject pattern must be a valid regular expression"),
    hasAttachments: z.boolean().optional(),
  })
  .strict();

const webhookFields = {
  agentId: z.string().min(1, "Choose an agent"),
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters"),
  url: z
    .string()
    .trim()
    .max(2048)
    .refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol), "URL must be a full http(s) URL, e.g. https://example.com/hooks/mail")
    .refine((u) => !URL.canParse(u) || (!new URL(u).username && !new URL(u).password), "URL must not contain credentials; verify requests with the signing secret instead"),
  eventTypes: z.array(z.enum(EVENT_TYPES)).min(1, "Pick at least one event type"),
  filter: webhookFilterSchema,
  includeBody: z.boolean(),
  enabled: z.boolean(),
};

export const webhookInputSchema = z
  .object({
    ...webhookFields,
    filter: webhookFilterSchema.default({}),
    includeBody: z.boolean().default(false),
    enabled: z.boolean().default(true),
  });

export const webhookPatchSchema = z.object(webhookFields).partial();

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

/** Drops empty lists and blank values so stored filters stay minimal. */
export function normalizeFilter(f: WebhookFilter): WebhookFilter {
  const out: WebhookFilter = {};
  const lists = ["accountIds", "labelIds", "from", "to"] as const;
  for (const key of lists) {
    const v = f[key]?.map((s) => s.trim()).filter(Boolean);
    if (v?.length) out[key] = [...new Set(v)];
  }
  if (f.subject?.trim()) out.subject = f.subject;
  if (typeof f.hasAttachments === "boolean") out.hasAttachments = f.hasAttachments;
  return out;
}

/** Whether an event passes a webhook filter. Every set criterion must pass. */
export function matchesFilter(f: WebhookFilter, ev: StoredEvent): boolean {
  if (f.accountIds?.length && !f.accountIds.includes(ev.accountId)) return false;
  if (ACCOUNT_EVENT_TYPES.includes(ev.type)) return true;
  const hasMessageCriteria = !!(f.labelIds?.length || f.from?.length || f.to?.length || f.subject || f.hasAttachments !== undefined);
  const m = ev.message;
  if (!m) return !hasMessageCriteria;
  if (f.labelIds?.length) {
    // Label events also match on the labels that changed (a removed label is no longer on the message).
    const labels = new Set([...m.labelIds, ...(ev.labelIds ?? [])]);
    if (!f.labelIds.some((l) => labels.has(l))) return false;
  }
  if (f.from?.length && !(m.from && matchesAnyGlob(m.from.email, f.from))) return false;
  if (f.to?.length && ![...m.to, ...m.cc].some((a) => matchesAnyGlob(a.email, f.to!))) return false;
  if (f.subject && !safeRegExp(f.subject)?.test(m.subject)) return false;
  if (f.hasAttachments !== undefined && m.hasAttachments !== f.hasAttachments) return false;
  return true;
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}
