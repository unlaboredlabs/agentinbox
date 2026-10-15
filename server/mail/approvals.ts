import { type Address, type Approval, type ApprovalStatus, type CalendarApprovalDetail, isCalendarApprovalKind } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { bool, json, now } from "../db/index.ts";
import { AccountNeedsReauthError, type GmailMessage, type GmailPart, GoogleApiError } from "../google/types.ts";
import { disallowedRecipients } from "../policy/enforce.ts";
import { conflict, errorMessage, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";

export interface ApprovalPayload {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  body: string;
  threadId: string | null;
  attachments: { filename: string; size: number }[];
  reason: string | null;
  /** Fingerprint of the Gmail draft when it was queued; a mismatch at approval means it was edited in Gmail. */
  fingerprint?: string;
  /** Calendar kinds: the change to apply (to/subject/body mirror it for generic lists, see Approval). */
  calendar?: CalendarApprovalDetail;
}

interface ApprovalRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  account_id: string;
  account_email: string | null;
  kind: Approval["kind"];
  status: ApprovalStatus;
  draft_id: string;
  payload: string;
  decided_at: string | null;
  decision_note: string | null;
  sent_message_id: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
}

const SELECT = `SELECT p.*, ag.name AS agent_name, ac.email AS account_email
  FROM approvals p LEFT JOIN agents ag ON ag.id = p.agent_id LEFT JOIN accounts ac ON ac.id = p.account_id`;

/** Approvals left "approved" without a sent message for this long were interrupted (e.g. a crash mid-send). */
const STUCK_AFTER_MS = 10 * 60_000;

function toApproval(r: ApprovalRow): Approval {
  const p = json.parse<Partial<ApprovalPayload>>(r.payload, {});
  return {
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name ?? r.agent_id,
    accountId: r.account_id,
    accountEmail: r.account_email ?? r.account_id,
    kind: r.kind,
    status: r.status,
    draftId: r.draft_id,
    to: p.to ?? [],
    cc: p.cc ?? [],
    bcc: p.bcc ?? [],
    subject: p.subject ?? "",
    body: p.body ?? "",
    threadId: p.threadId ?? null,
    attachments: p.attachments ?? [],
    reason: p.reason ?? null,
    ...(isCalendarApprovalKind(r.kind) && p.calendar ? { calendar: p.calendar } : {}),
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    sentMessageId: r.sent_message_id,
    error: r.error,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** Stable digest of a draft's message: its id (changes when edited in Gmail), headers that matter and every part. */
export function draftFingerprint(msg: GmailMessage): string {
  const parts: unknown[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    parts.push([p.mimeType, p.filename ?? "", p.body?.size ?? 0, p.body?.data ?? "", p.body?.attachmentId ? "att" : ""]);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  const keep = new Set(["from", "to", "cc", "bcc", "subject", "reply-to", "in-reply-to", "references"]);
  const headers = (msg.payload?.headers ?? []).filter((h) => keep.has(h.name.toLowerCase())).map((h) => [h.name.toLowerCase(), h.value]);
  return sha256(json.str([msg.id, headers, parts]));
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/** Worth retrying: rate limits, Google outages, connection failures, or an account waiting to be reconnected. */
function isTransient(err: unknown): boolean {
  if (err instanceof AccountNeedsReauthError) return true;
  if (err instanceof GoogleApiError) return err.status === 429 || err.status >= 500;
  // fetch() network failures: TypeError("fetch failed") with a system error code as the cause.
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return err instanceof TypeError && typeof code === "string" && NETWORK_CODES.has(code);
}

/** Prefix of the decision note on approvals cancelled automatically (status stays "rejected"). */
export const CANCELLED_PREFIX = "cancelled: ";

/** Approval persistence and admin decisions. Agent-side creation goes through `create`. */
export class Approvals {
  constructor(private readonly ctx: AppContext) {}

  get(id: string): Approval | null {
    const r = this.ctx.db.get<ApprovalRow>(`${SELECT} WHERE p.id = ?`, id);
    return r ? toApproval(r) : null;
  }

  list(status?: ApprovalStatus): Approval[] {
    const order = "ORDER BY p.created_at DESC, p.rowid DESC LIMIT 500";
    const rows = status
      ? this.ctx.db.all<ApprovalRow>(`${SELECT} WHERE p.status = ? ${order}`, status)
      : this.ctx.db.all<ApprovalRow>(`${SELECT} ${order}`);
    return rows.map(toApproval);
  }

  create(input: { agentId: string; accountId: string; kind: Approval["kind"]; draftId: string; payload: ApprovalPayload }): Approval {
    const id = newId("apr");
    const created = new Date();
    const expires = new Date(created.getTime() + this.ctx.settings.get().approvalTtlHours * 3_600_000);
    this.ctx.db.run(
      `INSERT INTO approvals (id, agent_id, account_id, kind, status, draft_id, payload, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      id,
      input.agentId,
      input.accountId,
      input.kind,
      input.draftId,
      json.str(input.payload),
      created.toISOString(),
      expires.toISOString(),
    );
    return this.emit(id);
  }

  async approve(id: string, note?: string | null): Promise<Approval> {
    const started = Date.now();
    await this.expireOverdue();
    const current = this.require(id);
    if (current.status !== "pending") throw this.notPending(current);

    // The human approves a send by this agent under its current grant: both must still allow it.
    const blocked = this.sendBlockedReason(current);
    if (blocked) {
      this.cancel([current.id], `${CANCELLED_PREFIX}${blocked}`);
      throw conflict(`This request can no longer be sent: ${blocked}.`, "It was cancelled and its draft deleted.");
    }

    // Claim atomically so two clicks can't send twice.
    if (!this.transition(id, "pending", "approved", note)) throw this.notPending(current);
    this.emit(id);
    if (isCalendarApprovalKind(current.kind)) return this.applyCalendar(current, started);
    const gmail = this.ctx.google.gmail(current.accountId);
    try {
      const expected = this.payload(id).fingerprint;
      if (expected) {
        const draft = await gmail.getDraft(current.draftId);
        if (draftFingerprint(draft.message) !== expected) {
          this.fail(id, "The draft was changed in Gmail after the agent queued it, so it was not sent. Review and send it from Gmail, or reject this request.");
          this.audit("approval.approve", current, "error", started, { error: "draft_changed" });
          return this.emit(id);
        }
      }
      const sent = await gmail.sendDraft(current.draftId);
      this.ctx.db.run("UPDATE approvals SET status = 'sent', sent_message_id = ?, error = NULL WHERE id = ?", sent.id, id);
      this.kick(current.accountId);
      this.audit("approval.approve", current, "ok", started, { sentMessageId: sent.id });
    } catch (err) {
      const message = errorMessage(err);
      if (isTransient(err)) {
        // Nothing was sent: put it back so the operator can approve again.
        this.ctx.db.run(
          "UPDATE approvals SET status = 'pending', decided_at = NULL, error = ? WHERE id = ? AND status = 'approved'",
          `Sending failed temporarily (${message}). Approve again to retry.`,
          id,
        );
      } else if (err instanceof GoogleApiError && err.status === 404) {
        this.fail(id, "The draft no longer exists in Gmail (it may have been sent or deleted there).");
      } else {
        this.fail(id, message);
      }
      this.audit("approval.approve", current, "error", started, { error: message, transient: isTransient(err) });
    }
    return this.emit(id);
  }

  /** Calendar kinds: the stored change goes to Google Calendar (server/calendar/approvals.ts); "sent" = applied. */
  private async applyCalendar(current: Approval, started: number): Promise<Approval> {
    const id = current.id;
    try {
      const { eventId } = await this.ctx.calendar.applyApproval(current);
      this.ctx.db.run("UPDATE approvals SET status = 'sent', sent_message_id = ?, error = NULL WHERE id = ?", eventId, id);
      this.audit("approval.approve", current, "ok", started, { eventId });
    } catch (err) {
      const message = errorMessage(err);
      if (isTransient(err)) {
        this.ctx.db.run(
          "UPDATE approvals SET status = 'pending', decided_at = NULL, error = ? WHERE id = ? AND status = 'approved'",
          `Applying the change failed temporarily (${message}). Approve again to retry.`,
          id,
        );
      } else {
        this.fail(id, message);
      }
      this.audit("approval.approve", current, "error", started, { error: message, transient: isTransient(err) });
    }
    return this.emit(id);
  }

  async reject(id: string, note?: string | null): Promise<Approval> {
    const started = Date.now();
    await this.expireOverdue();
    const current = this.require(id);
    if (!this.transition(id, "pending", "rejected", note)) throw this.notPending(current);
    await this.deleteDraft(current);
    this.audit("approval.reject", current, "ok", started, null);
    return this.emit(id);
  }

  /** Marks overdue pending approvals expired and deletes their drafts. */
  async expireOverdue(): Promise<number> {
    const due = this.ctx.db.all<ApprovalRow>(`${SELECT} WHERE p.status = 'pending' AND p.expires_at <= ?`, now());
    let count = 0;
    for (const r of due) {
      if (!this.transition(r.id, "pending", "expired", null)) continue;
      count++;
      const a = toApproval(r);
      await this.deleteDraft(a);
      this.ctx.audit.record({ actorType: "system", action: "approval.expire", accountId: a.accountId, target: a.id, outcome: "ok" });
      this.emit(r.id);
    }
    return count;
  }

  /** Deletes decided approvals older than `beforeIso` (pending and in-flight ones are kept). */
  prune(beforeIso: string): number {
    return this.ctx.db.run(
      "DELETE FROM approvals WHERE status IN ('sent', 'rejected', 'failed', 'expired') AND COALESCE(decided_at, created_at) < ?",
      beforeIso,
    ).changes;
  }

  /** Approvals stuck in "approved" (the process died between claiming and sending) go back to pending. */
  recoverInterrupted(olderThanMs = STUCK_AFTER_MS): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.ctx.db.all<{ id: string }>(
      "SELECT id FROM approvals WHERE status = 'approved' AND sent_message_id IS NULL AND decided_at < ? ORDER BY rowid",
      cutoff,
    );
    for (const { id } of rows) {
      this.ctx.db.run(
        "UPDATE approvals SET status = 'pending', decided_at = NULL, error = ? WHERE id = ? AND status = 'approved'",
        "Sending was interrupted before it finished. Approve again to retry (if it was actually sent, the retry fails harmlessly).",
        id,
      );
      this.ctx.audit.record({ actorType: "system", action: "approval.recover", target: id, outcome: "ok" });
      this.emit(id);
    }
    return rows.length;
  }

  /**
   * Rejects the agent's pending approvals (optionally for one account) after its access changed, and deletes
   * their drafts in the background. Synchronous so callers can run it right before deleting the agent.
   */
  cancelForAgent(agentId: string, accountId: string | null, why: string, only?: "mail" | "calendar"): number {
    const rows = accountId
      ? this.ctx.db.all<{ id: string; kind: string }>("SELECT id, kind FROM approvals WHERE status = 'pending' AND agent_id = ? AND account_id = ?", agentId, accountId)
      : this.ctx.db.all<{ id: string; kind: string }>("SELECT id, kind FROM approvals WHERE status = 'pending' AND agent_id = ?", agentId);
    return this.cancel(
      rows.filter((r) => !only || (only === "calendar") === isCalendarApprovalKind(r.kind)).map((r) => r.id),
      `${CANCELLED_PREFIX}${why}`,
    );
  }

  private cancel(ids: string[], note: string): number {
    const drafts: Approval[] = [];
    for (const id of ids) {
      if (!this.transition(id, "pending", "rejected", note)) continue;
      const a = this.emit(id);
      drafts.push(a);
      this.ctx.audit.record({ actorType: "system", action: "approval.cancel", accountId: a.accountId, target: id, outcome: "ok", detail: { note } });
    }
    if (drafts.length) void Promise.all(drafts.map((a) => this.deleteDraft(a)));
    return drafts.length;
  }

  /** Why this send is no longer allowed under the agent's current grant, or null. */
  private sendBlockedReason(a: Approval): string | null {
    if (isCalendarApprovalKind(a.kind)) return this.ctx.calendar.approvalBlockedReason(a);
    const agent = this.ctx.db.get<{ disabled: number }>("SELECT disabled FROM agents WHERE id = ?", a.agentId);
    if (!agent) return "the agent was deleted";
    if (bool(agent.disabled)) return "the agent is disabled";
    const grant = this.ctx.policy.grant(a.agentId, a.accountId);
    if (!grant || !grant.capabilities.includes("send")) return "the agent is no longer allowed to send from this account";
    if (grant.replyOnly && a.kind !== "reply") return "the agent may now only send replies from this account";
    const bad = disallowedRecipients(
      grant,
      [...a.to, ...a.cc, ...a.bcc].map((x) => x.email),
    );
    if (bad.length) return `the agent may no longer send to ${bad.join(", ")}`;
    return null;
  }

  private payload(id: string): Partial<ApprovalPayload> {
    const r = this.ctx.db.get<{ payload: string }>("SELECT payload FROM approvals WHERE id = ?", id);
    return json.parse<Partial<ApprovalPayload>>(r?.payload, {});
  }

  private fail(id: string, error: string): void {
    this.ctx.db.run("UPDATE approvals SET status = 'failed', error = ? WHERE id = ?", error, id);
  }

  private require(id: string): Approval {
    const a = this.get(id);
    if (!a) throw notFound("Approval");
    return a;
  }

  private notPending(a: Approval) {
    const fresh = this.get(a.id) ?? a;
    return conflict(`This request is already ${fresh.status}`, "Only pending requests can be approved or rejected.");
  }

  private transition(id: string, from: ApprovalStatus, to: ApprovalStatus, note: string | null | undefined): boolean {
    return (
      this.ctx.db.run(
        "UPDATE approvals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = ?",
        to,
        now(),
        note?.trim() || null,
        id,
        from,
      ).changes > 0
    );
  }

  private async deleteDraft(a: Approval): Promise<void> {
    // Calendar approvals have no draft: nothing reached Google before approval.
    if (isCalendarApprovalKind(a.kind) || !a.draftId) return;
    try {
      await this.ctx.google.gmail(a.accountId).deleteDraft(a.draftId);
    } catch (err) {
      // Already sent/deleted by a human in Gmail, or the account is gone: nothing left to clean up.
      this.ctx.log.debug("Could not delete approval draft", { approval: a.id, error: errorMessage(err) });
    }
  }

  private kick(accountId: string): void {
    try {
      this.ctx.ingest.kick(accountId);
    } catch {
      // ingest.kick never throws once implemented; tolerate placeholders.
    }
  }

  private audit(action: string, a: Approval, outcome: "ok" | "error", started: number, detail: Record<string, unknown> | null) {
    this.ctx.audit.record({
      actorType: "admin",
      actorId: null,
      action,
      accountId: a.accountId,
      target: a.id,
      outcome,
      durationMs: Date.now() - started,
      detail: { agentId: a.agentId, kind: a.kind, ...detail },
    });
  }

  private emit(id: string): Approval {
    const a = this.get(id)!;
    this.ctx.bus.emit("approval", a);
    return a;
  }
}
