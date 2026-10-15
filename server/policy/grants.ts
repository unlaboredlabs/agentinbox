import { z } from "zod";
import { CAPABILITIES, type Grant, type GrantInput, SEND_MODES } from "../../shared/types.ts";
import { bool, json } from "../db/index.ts";
import { badRequest } from "../util/errors.ts";

/** Address glob: exactly one "@" with a non-empty local part and domain; "*" wildcards allowed. */
const ADDRESS_GLOB = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+$/;

const positiveCap = z.number().int("must be a whole number").positive("must be at least 1").max(100_000).nullable();

export const grantInputSchema = z.object({
  accountId: z.string().min(1),
  capabilities: z
    .array(z.enum(CAPABILITIES))
    .min(1, "Pick at least one capability (delete the grant to remove access)")
    .transform((caps) => CAPABILITIES.filter((c) => caps.includes(c))),
  labelScope: z
    .array(z.string().trim().min(1))
    .min(1, "Label scope must list at least one label, or be null for the whole mailbox")
    .transform((ids) => [...new Set(ids)])
    .nullable(),
  sendMode: z.enum(SEND_MODES).default("draft_only"),
  allowTo: z
    .array(
      z
        .string()
        .trim()
        .transform((g) => g.replace(/[A-Z]/g, (c) => c.toLowerCase()))
        .pipe(z.string().regex(ADDRESS_GLOB, 'Recipient rules must look like "alice@example.com", "*@example.com" or "billing@*"')),
    )
    .max(200)
    .transform((globs) => [...new Set(globs)]),
  replyOnly: z.boolean(),
  maxSendsPerHour: positiveCap,
  maxSendsPerDay: positiveCap,
});

/** Validates and normalizes a grant. Throws HttpError(400). */
export function parseGrantInput(input: unknown): GrantInput {
  const r = grantInputSchema.safeParse(input);
  if (!r.success) throw badRequest(`Invalid grant: ${z.prettifyError(r.error)}`);
  return r.data;
}

export interface GrantRow {
  id: string;
  agent_id: string;
  account_id: string;
  capabilities: string;
  label_scope: string | null;
  send_mode: Grant["sendMode"];
  allow_to: string;
  reply_only: number;
  max_sends_per_hour: number | null;
  max_sends_per_day: number | null;
  created_at: string;
}

export const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  agentId: r.agent_id,
  accountId: r.account_id,
  capabilities: json.parse(r.capabilities, []),
  labelScope: r.label_scope === null ? null : json.parse<string[] | null>(r.label_scope, null),
  sendMode: r.send_mode,
  allowTo: json.parse(r.allow_to, []),
  replyOnly: bool(r.reply_only),
  maxSendsPerHour: r.max_sends_per_hour,
  maxSendsPerDay: r.max_sends_per_day,
  createdAt: r.created_at,
});
