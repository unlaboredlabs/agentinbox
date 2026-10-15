// Action-side guardrails as pure functions over a Grant: label scope, query rewriting, recipient
// allowlists and send caps. Callers (server/mail/agent.ts) throw these as PolicyDenied.

import type { Capability, GmailLabel, Grant } from "../../shared/types.ts";
import type { Db } from "../db/index.ts";
import { matchesAnyGlob } from "../util/glob.ts";
import { PolicyDenied } from "../util/errors.ts";

/** MCP tools that send mail. Successful calls (sent, draft created, approval queued) count toward send caps. */
export const SEND_ACTIONS = ["send_message", "reply", "forward"] as const;

export const CAPABILITY_HELP: Record<Capability, string> = {
  read: "read and search mail",
  draft: "create drafts",
  send: "send mail",
  organize: "change labels, archive or mark read",
  trash: "move mail to the trash",
};

// ───────────── Label scope ─────────────

export function inScope(scope: string[] | null, labelIds: Iterable<string>): boolean {
  if (scope === null) return true;
  for (const id of labelIds) if (scope.includes(id)) return true;
  return false;
}

/** Thread-level label union. */
export function threadLabels(thread: { messages?: { labelIds?: string[] }[] }): string[] {
  const out = new Set<string>();
  for (const m of thread.messages ?? []) for (const id of m.labelIds ?? []) out.add(id);
  return [...out];
}

/** The message shown to the agent for out-of-scope or missing ids: never reveals that something exists. */
export const notAccessible = (what: "Thread" | "Message", id: string) =>
  `${what} ${id} was not found or is not accessible to you. Use search_threads to find mail you can access.`;

const SYSTEM_TERMS: Record<string, string> = {
  INBOX: "in:inbox",
  SENT: "in:sent",
  DRAFT: "in:drafts",
  SPAM: "in:spam",
  TRASH: "in:trash",
  CHAT: "in:chats",
  STARRED: "is:starred",
  UNREAD: "is:unread",
  IMPORTANT: "is:important",
  CATEGORY_PERSONAL: "category:primary",
  CATEGORY_SOCIAL: "category:social",
  CATEGORY_PROMOTIONS: "category:promotions",
  CATEGORY_UPDATES: "category:updates",
  CATEGORY_FORUMS: "category:forums",
};

/** Gmail search term for a label: `in:inbox` for system labels, `label:"Name"` (quoted when needed) for user labels. */
export function labelSearchTerm(label: GmailLabel): string {
  const system = SYSTEM_TERMS[label.id];
  if (system) return system;
  if (label.type === "system") return `label:${label.id.toLowerCase()}`;
  const name = label.name.replace(/"/g, "");
  return /^[\w/-]+$/u.test(name) ? `label:${name}` : `label:"${name}"`;
}

/**
 * Checks that parentheses, braces and double quotes are balanced so a query can't close the wrapping
 * group and OR its way out of the scope. Returns an error message, or null when fine.
 */
export function querySyntaxError(q: string): string | null {
  if (q.length > 2000) return "Query is too long (max 2000 characters).";
  let paren = 0;
  let brace = 0;
  let quoted = false;
  for (const ch of q) {
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    if (paren < 0 || brace < 0) return "Query has an unmatched closing parenthesis or brace.";
  }
  if (quoted) return "Query has an unmatched double quote.";
  if (paren || brace) return "Query has an unmatched opening parenthesis or brace.";
  return null;
}

/**
 * ANDs the label scope onto a user query: `(<q>) (label:a OR in:inbox)`. Returns null when none of the
 * scope labels exist any more (nothing can match). The caller must still post-filter results.
 */
export function scopedQuery(q: string, scope: string[] | null, labels: GmailLabel[]): string | null {
  const userQ = q.trim();
  if (scope === null) return userQ;
  const terms = scope.map((id) => labels.find((l) => l.id === id)).filter((l) => l !== undefined).map(labelSearchTerm);
  if (!terms.length) return null;
  const scopeClause = terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
  return userQ ? `(${userQ}) ${scopeClause}` : scopeClause;
}

// ───────────── Send rules ─────────────

/** Recipients the grant's allowlist doesn't cover (empty allowlist = anyone). */
export function disallowedRecipients(grant: Grant, emails: string[]): string[] {
  if (!grant.allowTo.length) return [];
  return emails.filter((e) => !matchesAnyGlob(e, grant.allowTo));
}

export function assertRecipientsAllowed(grant: Grant, emails: string[]): void {
  const bad = disallowedRecipients(grant, emails);
  if (bad.length) {
    throw new PolicyDenied(
      "allow_to",
      `Not allowed to send to ${bad.join(", ")}. This account only lets you send to: ${grant.allowTo.join(", ")}. ` +
        "Remove those recipients, or ask the operator to extend the allowlist.",
    );
  }
}

/** Successful send/reply/forward calls by this agent on this account since `sinceIso` (from the audit log). */
export function sendsSince(db: Db, agentId: string, accountId: string, sinceIso: string): number {
  const placeholders = SEND_ACTIONS.map(() => "?").join(", ");
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_log
     WHERE actor_type = 'agent' AND actor_id = ? AND ts >= ? AND account_id = ? AND outcome = 'ok' AND action IN (${placeholders})`,
    agentId,
    sinceIso,
    accountId,
    ...SEND_ACTIONS,
  );
  return row?.n ?? 0;
}

export function assertWithinSendCaps(db: Db, grant: Grant, at = Date.now()): void {
  const windows = [
    { cap: grant.maxSendsPerHour, ms: 3_600_000, label: "hour" },
    { cap: grant.maxSendsPerDay, ms: 86_400_000, label: "24 hours" },
  ];
  for (const w of windows) {
    if (w.cap === null) continue;
    const used = sendsSince(db, grant.agentId, grant.accountId, new Date(at - w.ms).toISOString());
    if (used >= w.cap) {
      throw new PolicyDenied(
        "rate_limit",
        `Send limit reached: ${used} of ${w.cap} sends in the last ${w.label} for this account. ` +
          "Try again later, or save it as a draft (create_draft, if available) for a human to send.",
      );
    }
  }
}
