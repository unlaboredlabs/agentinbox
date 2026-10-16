// SQL for policy and approvals: connection status, "always allow" rules, mcp.call approval rows, limits.
// Tables from migration 8 (server/db/schema.ts).

import type { ApprovalRule, ConnectionStatus, McpCallApprovalDetail } from "../../../shared/types.ts";
import { type Db, json, now } from "../../db/index.ts";
import type { SettingsStore } from "../../settings.ts";
import { newId } from "../../util/ids.ts";
import { canonicalJson } from "./canonical.ts";

export const BROKER_POLICY_DEFAULTS = { approvalTtlHours: 24, riskyPerHour: 30, riskyPerDay: 200 } as const;

export interface BrokerLimits {
  approvalTtlHours: number;
  riskyPerHour: number | null;
  riskyPerDay: number | null;
}

export function brokerLimits(settings: SettingsStore): BrokerLimits {
  const s = settings.getState("broker.policy") ?? {};
  return {
    approvalTtlHours: s.approvalTtlHours ?? BROKER_POLICY_DEFAULTS.approvalTtlHours,
    riskyPerHour: s.riskyPerHour === undefined ? BROKER_POLICY_DEFAULTS.riskyPerHour : s.riskyPerHour,
    riskyPerDay: s.riskyPerDay === undefined ? BROKER_POLICY_DEFAULTS.riskyPerDay : s.riskyPerDay,
  };
}

export interface ConnectionInfo {
  id: string;
  slug: string;
  name: string;
  status: ConnectionStatus;
  statusReason: string | null;
}

export function connectionInfo(db: Db, id: string): ConnectionInfo | null {
  const r = db.get<{ id: string; slug: string; name: string; status: ConnectionStatus; status_reason: string | null }>(
    "SELECT id, slug, name, status, status_reason FROM connections WHERE id = ?",
    id,
  );
  return r ? { id: r.id, slug: r.slug, name: r.name, status: r.status, statusReason: r.status_reason } : null;
}

// ───────────── Rules ─────────────

interface RuleRow {
  id: string;
  agent_id: string;
  connection_id: string;
  tool: string;
  target_path: string | null;
  target_value: string | null;
  created_at: string;
}

const toRule = (r: RuleRow): ApprovalRule => ({
  id: r.id,
  agentId: r.agent_id,
  connectionId: r.connection_id,
  tool: r.tool,
  targetPath: r.target_path,
  targetValue: r.target_value,
  createdAt: r.created_at,
});

export function rulesFor(db: Db, agentId: string, connectionId: string, tool: string): ApprovalRule[] {
  return db
    .all<RuleRow>("SELECT * FROM approval_rules WHERE agent_id = ? AND connection_id = ? AND tool = ? ORDER BY created_at, rowid", agentId, connectionId, tool)
    .map(toRule);
}

export function listRules(db: Db, q: { agentId?: string; connectionId?: string } = {}): ApprovalRule[] {
  const where: string[] = [];
  const params: string[] = [];
  if (q.agentId) {
    where.push("agent_id = ?");
    params.push(q.agentId);
  }
  if (q.connectionId) {
    where.push("connection_id = ?");
    params.push(q.connectionId);
  }
  return db.all<RuleRow>(`SELECT * FROM approval_rules ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT 1000`, ...params).map(toRule);
}

export function getRule(db: Db, id: string): ApprovalRule | null {
  const r = db.get<RuleRow>("SELECT * FROM approval_rules WHERE id = ?", id);
  return r ? toRule(r) : null;
}

/** Inserts the rule unless an identical one exists (unique index); returns the stored rule. */
export function addRule(db: Db, r: { agentId: string; connectionId: string; tool: string; targetPath: string | null; targetValue: string | null }): ApprovalRule {
  const id = newId("rul");
  db.run(
    `INSERT INTO approval_rules (id, agent_id, connection_id, tool, target_path, target_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    id,
    r.agentId,
    r.connectionId,
    r.tool,
    r.targetPath,
    r.targetValue,
    now(),
  );
  const row = db.get<RuleRow>(
    `SELECT * FROM approval_rules WHERE agent_id = ? AND connection_id = ? AND tool = ? AND COALESCE(target_path, '') = ? AND COALESCE(target_value, '') = ?`,
    r.agentId,
    r.connectionId,
    r.tool,
    r.targetPath ?? "",
    r.targetValue ?? "",
  );
  return toRule(row!);
}

export function deleteRule(db: Db, id: string): boolean {
  return db.run("DELETE FROM approval_rules WHERE id = ?", id).changes > 0;
}

/**
 * Whether the rules allow a call without asking: a rule without a target covers every call; target rules
 * cover the call when the value at their path is covered. An array value (e.g. Notion's `page_ids`) is
 * covered only when every element has a rule of its own; an empty array or a missing value isn't covered.
 */
export function rulesAllow(rules: ApprovalRule[], targetValue: (path: string) => unknown): ApprovalRule | null {
  const untargeted = rules.find((r) => r.targetPath === null);
  if (untargeted) return untargeted;
  const byPath = new Map<string, ApprovalRule[]>();
  for (const r of rules) if (r.targetPath !== null) byPath.set(r.targetPath, [...(byPath.get(r.targetPath) ?? []), r]);
  for (const [path, list] of byPath) {
    const v = targetValue(path);
    if (v === undefined) continue;
    const covered = (x: unknown) => {
      let c: string;
      try {
        c = canonicalJson(x);
      } catch {
        return null;
      }
      return list.find((r) => r.targetValue === c) ?? null;
    };
    if (Array.isArray(v)) {
      if (!v.length) continue;
      const hits = v.map(covered);
      if (hits.every((h) => h !== null)) return hits[0]!;
    } else {
      const hit = covered(v);
      if (hit) return hit;
    }
  }
  return null;
}

// ───────────── mcp.call approvals ─────────────

export interface McpCallRow {
  id: string;
  agent_id: string;
  connection_id: string;
  kind: "mcp.call";
  status: string;
  tool_call: string;
  payload: string;
  decided_at: string | null;
  decision_note: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
}

export function mcpCallRow(db: Db, id: string): McpCallRow | null {
  return db.get<McpCallRow>("SELECT * FROM approvals WHERE id = ? AND kind = 'mcp.call'", id) ?? null;
}

export function insertMcpCall(db: Db, input: { agentId: string; connectionId: string; call: McpCallApprovalDetail; reason: string | null; ttlHours: number }): string {
  const id = newId("apr");
  const created = new Date();
  const expires = new Date(created.getTime() + input.ttlHours * 3_600_000);
  // payload keeps the mail-shaped fields empty so generic lists (and older consoles) read it.
  const payload = { to: [], cc: [], bcc: [], subject: input.call.exposedName, body: "", threadId: null, attachments: [], reason: input.reason };
  db.run(
    `INSERT INTO approvals (id, agent_id, account_id, connection_id, kind, status, draft_id, payload, tool_call, created_at, expires_at)
     VALUES (?, ?, NULL, ?, 'mcp.call', 'pending', NULL, ?, ?, ?, ?)`,
    id,
    input.agentId,
    input.connectionId,
    json.str(payload),
    json.str(input.call),
    created.toISOString(),
    expires.toISOString(),
  );
  return id;
}

export function updateToolCall(db: Db, id: string, patch: Partial<McpCallApprovalDetail>): void {
  const row = mcpCallRow(db, id);
  if (!row) return;
  const call = { ...json.parse<McpCallApprovalDetail>(row.tool_call, { tool: "", exposedName: "", args: "", argsSha256: "", pinHash: "" }), ...patch };
  db.run("UPDATE approvals SET tool_call = ? WHERE id = ?", json.str(call), id);
}

/** Atomic status change; false when the row wasn't in `from` (someone else decided first). */
export function transition(db: Db, id: string, from: string, to: string, note?: string | null): boolean {
  return db.run("UPDATE approvals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = ? AND kind = 'mcp.call'", to, now(), note?.trim() || null, id, from)
    .changes > 0;
}
