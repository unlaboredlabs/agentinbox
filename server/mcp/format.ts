// Text formatting of tool results. Compact and scannable: agents read these.

import type { Account, Approval, GmailLabel, Grant, MailEvent } from "../../shared/types.ts";
import type { FeedResult } from "../events/types.ts";
import type { RenderedMessage, SendOutcome, ThreadSummary } from "../mail/agent.ts";
import { cleanLine, formatAddress, formatAddresses, labelNames, renderMessage } from "../mail/content.ts";

const SEND_MODE_HELP: Record<Grant["sendMode"], string> = {
  direct: "sent immediately",
  draft_only: "saved as Gmail drafts for a human to send",
  approval: "queued for human approval before sending",
};

/** Untrusted one-liners (subjects, snippets) go through the same cleaning as bodies. */
const clip = (s: string, n: number) => cleanLine(s, n);

export function formatAccounts(items: { grant: Grant; account: Account; scopeNames: string[] | null }[]): string {
  if (!items.length) return "You don't have access to any account yet. Ask the operator to grant this agent access in the agentinbox console.";
  const lines = [`You can access ${items.length} account${items.length === 1 ? "" : "s"}:`];
  for (const { grant: g, account: a, scopeNames } of items) {
    lines.push(`- ${a.email} (account id ${a.id})${a.status === "active" ? "" : ` · status: ${a.status}`}`);
    lines.push(`  can: ${g.capabilities.join(", ")}`);
    if (g.capabilities.includes("send")) {
      const rules = [`messages are ${SEND_MODE_HELP[g.sendMode]}`];
      if (g.replyOnly) rules.push("replies only (no new messages or forwards)");
      if (g.allowTo.length) rules.push(`recipients limited to ${g.allowTo.join(", ")}`);
      const caps = [g.maxSendsPerHour && `${g.maxSendsPerHour}/hour`, g.maxSendsPerDay && `${g.maxSendsPerDay}/day`].filter(Boolean);
      if (caps.length) rules.push(`limit ${caps.join(", ")}`);
      lines.push(`  sending: ${rules.join("; ")}`);
    }
    if (scopeNames) lines.push(`  limited to threads labeled: ${scopeNames.join(", ")}`);
  }
  return lines.join("\n");
}

export function formatLabels(account: Account, labels: GmailLabel[], scope: string[] | null): string {
  const sorted = [...labels].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "system" ? -1 : 1));
  const lines = [`Labels in ${account.email}${scope ? " (* = in your label scope)" : ""}:`];
  for (const l of sorted) lines.push(`- ${clip(l.name, 200)}${l.name !== l.id ? ` (id ${l.id})` : ""}${scope?.includes(l.id) ? " *" : ""}`);
  return lines.join("\n");
}

export function formatSearch(
  account: Account,
  query: string,
  threads: ThreadSummary[],
  nextPageToken: string | null,
  labels: GmailLabel[] | null,
  hidden = 0,
): string {
  const more = nextPageToken ? `More results: call again with page_token "${nextPageToken}".` : null;
  if (!threads.length) {
    if (more) return `No results you can access on this page${hidden ? ` (${hidden} skipped)` : ""}; more may follow. ${more}`;
    return `No threads found in ${account.email} for ${query.trim() ? `"${clip(query, 200)}"` : "this search"}.`;
  }
  const lines = [`${threads.length} thread${threads.length === 1 ? "" : "s"} in ${account.email}${query.trim() ? ` for "${clip(query, 200)}"` : ""}:`];
  threads.forEach((t, i) => {
    const meta = [
      `thread_id: ${t.id}`,
      t.date,
      `From: ${formatAddress(t.from)}`,
      `${t.messageCount} message${t.messageCount === 1 ? "" : "s"}`,
      t.hasAttachments ? "has attachments" : null,
    ].filter(Boolean);
    lines.push(`${i + 1}. ${clip(t.subject, 200) || "(no subject)"}`);
    lines.push(`   ${meta.join(" · ")}`);
    if (t.labelIds.length) lines.push(`   Labels: ${labelNames(t.labelIds, labels).join(", ")}`);
    if (t.snippet) lines.push(`   Snippet: ${clip(t.snippet, 200)}`);
  });
  if (more) lines.push(more);
  return lines.join("\n");
}

export function formatThread(account: Account, threadId: string, messages: RenderedMessage[], labels: GmailLabel[] | null, maxChars: number): string {
  const head = `Thread ${threadId} in ${account.email} (${messages.length} message${messages.length === 1 ? "" : "s"}, oldest first)`;
  return [head, ...messages.map((m) => renderMessage(m.summary, m.content, labels, maxChars))].join("\n\n---\n\n");
}

export const formatMessage = (m: RenderedMessage, labels: GmailLabel[] | null, maxChars: number) =>
  renderMessage(m.summary, m.content, labels, maxChars);

export function formatSendOutcome(o: SendOutcome): string {
  return JSON.stringify(o, null, 2);
}

export function formatApprovalStatus(a: Approval): string {
  const next: Record<Approval["status"], string> = {
    pending: "Still waiting for a human decision. Check again later.",
    approved: "Approved; sending now. Check again shortly.",
    sent: "Sent.",
    rejected: "A human rejected this; it was not sent and the draft was deleted.",
    expired: "Nobody decided in time; it expired and was not sent.",
    failed: "Approved, but sending failed.",
  };
  return JSON.stringify(
    {
      approvalId: a.id,
      status: a.status,
      kind: a.kind,
      to: a.to.map((x) => x.email),
      subject: a.subject,
      sentMessageId: a.sentMessageId,
      decisionNote: a.decisionNote,
      error: a.error,
      expiresAt: a.expiresAt,
      message: next[a.status],
    },
    null,
    2,
  );
}

function formatEvent(e: MailEvent, labels: Map<string, GmailLabel[] | null>): string {
  const lines = [`#${e.seq} ${e.type} · ${e.accountEmail} · ${e.createdAt}`];
  const m = e.message;
  if (m) {
    lines.push(`  From: ${formatAddress(m.from)} · To: ${clip(formatAddresses(m.to), 120)} · Subject: ${clip(m.subject, 160) || "(no subject)"}`);
    const ids = [`thread_id: ${m.threadId}`, `message_id: ${m.id}`];
    if (m.labelIds.length) ids.push(`labels: ${labelNames(m.labelIds, labels.get(e.accountId) ?? null).join(", ")}`);
    if (m.hasAttachments) ids.push("has attachments");
    lines.push(`  ${ids.join(" · ")}`);
    if (m.snippet) lines.push(`  Snippet: ${clip(m.snippet, 200)}`);
  }
  if (e.labelIds?.length) lines.push(`  ${e.type === "label.removed" ? "Removed" : "Added"}: ${labelNames(e.labelIds, labels.get(e.accountId) ?? null).join(", ")}`);
  if (e.detail && Object.keys(e.detail).length) lines.push(`  Detail: ${clip(JSON.stringify(e.detail), 300)}`);
  return lines.join("\n");
}

export function formatFeed(r: FeedResult & { hasMore?: boolean }, labels: Map<string, GmailLabel[] | null>, waited?: number): string {
  // `hasMore` is additive in the events contract; undefined means false.
  const more = r.hasMore ? ` More events may be available; call again with after=${r.cursor}.` : "";
  if (!r.events.length) {
    const quiet = waited ? `No new events in the last ${waited} s.` : "No new events.";
    return `${quiet} Cursor: ${r.cursor} (acknowledged up to ${r.ackedSeq}).${more}`;
  }
  const last = r.events.at(-1)!.seq;
  return [
    `${r.events.length} event${r.events.length === 1 ? "" : "s"}:`,
    ...r.events.map((e) => formatEvent(e, labels)),
    "",
    `Next: pass after=${r.cursor} to continue. Once you've handled these, call ack_events with seq=${last}.${more}`,
  ].join("\n");
}
