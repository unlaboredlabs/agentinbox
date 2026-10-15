import type { Account, EventType, WebhookFilter, WebhookInput } from "@shared/types";
import { EVENT_TYPE_INFO } from "./labels";

export function regexError(pattern: string | undefined): string | null {
  if (!pattern) return null;
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (err) {
    return (err as Error).message.replace(/^Invalid regular expression: /, "");
  }
}

/** Drops empty filter fields so the stored filter only has what matters. */
export function cleanFilter(f: WebhookFilter): WebhookFilter {
  const out: WebhookFilter = {};
  if (f.accountIds?.length) out.accountIds = f.accountIds;
  if (f.labelIds?.length) out.labelIds = f.labelIds;
  if (f.from?.length) out.from = f.from;
  if (f.to?.length) out.to = f.to;
  if (f.subject?.trim()) out.subject = f.subject.trim();
  if (f.hasAttachments !== undefined) out.hasAttachments = f.hasAttachments;
  return out;
}

const list = (xs: string[], max = 3) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);

/** Plain-language description of what a webhook sends, e.g. for the editor preview and detail page. */
export function describeWebhook(w: Pick<WebhookInput, "eventTypes" | "filter" | "includeBody">, accounts: Account[]): string[] {
  const f = w.filter;
  const types = w.eventTypes.map((t: EventType) => EVENT_TYPE_INFO[t]?.label.toLowerCase() ?? t);
  const lines = [types.length ? `Sends ${list(types)} events` : "Sends nothing yet: pick at least one event type"];
  lines.push(
    f.accountIds?.length
      ? `from ${list(f.accountIds.map((id) => accounts.find((a) => a.id === id)?.email ?? id))}`
      : "from every account the agent can read",
  );
  if (f.labelIds?.length) lines.push(`only for messages labeled ${list(f.labelIds)}`);
  if (f.from?.length) lines.push(`where the sender matches ${list(f.from)}`);
  if (f.to?.length) lines.push(`where a recipient matches ${list(f.to)}`);
  if (f.subject) lines.push(`where the subject matches /${f.subject}/i`);
  if (f.hasAttachments === true) lines.push("with attachments only");
  if (f.hasAttachments === false) lines.push("without attachments only");
  lines.push(w.includeBody ? "including the cleaned message body" : "with metadata only (no body)");
  return lines;
}
