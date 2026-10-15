import type { Address, Approval, ApprovalStatus } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { json, now } from "../db/index.ts";
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
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    sentMessageId: r.sent_message_id,
    error: r.error,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** Approval persistence and admin decisions. Agent-side creation goes through `create`. */
export class Approvals {
  constructor(private readonly ctx: AppContext) {}

  get(id: string): Approval | null {
    const r = this.ctx.db.get<ApprovalRow>(`${SELECT} WHERE p.id = ?`, id);
    return r ? toApproval(r) : null;
  }

  list(status?: ApprovalStatus): Approval[] {
    const rows = status
      ? this.ctx.db.all<ApprovalRow>(`${SELECT} WHERE p.status = ? ORDER BY p.created_at DESC LIMIT 500`, status)
      : this.ctx.db.all<ApprovalRow>(`${SELECT} ORDER BY p.created_at DESC LIMIT 500`);
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
    // Claim atomically so two clicks can't send twice.
    if (!this.transition(id, "pending", "approved", note)) throw this.notPending(current);
    this.emit(id);
    try {
      const sent = await this.ctx.google.gmail(current.accountId).sendDraft(current.draftId);
      this.ctx.db.run("UPDATE approvals SET status = 'sent', sent_message_id = ? WHERE id = ?", sent.id, id);
      this.kick(current.accountId);
      this.audit("approval.approve", current, "ok", started, { sentMessageId: sent.id });
    } catch (err) {
      this.ctx.db.run("UPDATE approvals SET status = 'failed', error = ? WHERE id = ?", errorMessage(err), id);
      this.audit("approval.approve", current, "error", started, { error: errorMessage(err) });
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
