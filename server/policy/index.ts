import { z } from "zod";
import type { Agent, AgentWithKey, CreateAgentInput, Grant, GrantInput } from "../../shared/types.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { bool, json, now } from "../db/index.ts";
import { badRequest, notFound } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";
import { type GrantRow, parseGrantInput, toGrant } from "./grants.ts";
import type { AgentPrincipal, PolicyService } from "./types.ts";

export const API_KEY_PREFIX = "aib_";
/** 32 base32 chars = 160 bits of entropy. */
const KEY_RANDOM_CHARS = 32;
/** `last_used_at` is written at most this often per agent. */
const LAST_USED_THROTTLE_MS = 60_000;
/** Account-level events visible to any agent with `read` on the account, regardless of label scope. */
const ACCOUNT_EVENTS = new Set(["account.auth_failed", "sync.gap"]);

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  key_hash: string;
  disabled: number;
  last_used_at: string | null;
  created_at: string;
}

const agentFields = z.object({
  name: z.string().trim().min(1, "Name is required").max(80, "Name must be at most 80 characters"),
  description: z.string().trim().max(500).nullable().optional(),
  disabled: z.boolean().optional(),
});

function parseAgentFields(input: unknown) {
  const r = agentFields.partial({ name: true }).safeParse(input);
  if (!r.success) throw badRequest(z.prettifyError(r.error));
  return r.data;
}

export const newApiKey = (): string => API_KEY_PREFIX + randomToken(KEY_RANDOM_CHARS);

export function createPolicyService(ctx: AppContext): PolicyService {
  const { db } = ctx;

  const grantsOf = (agentId: string): Grant[] =>
    db.all<GrantRow>("SELECT * FROM grants WHERE agent_id = ? ORDER BY created_at, id", agentId).map(toGrant);

  const toAgent = (r: AgentRow): Agent => ({
    id: r.id,
    name: r.name,
    description: r.description,
    keyPrefix: r.key_prefix,
    disabled: bool(r.disabled),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    grants: grantsOf(r.id),
  });

  const row = (id: string) => db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  const requireRow = (id: string) => {
    const r = row(id);
    if (!r) throw notFound("Agent");
    return r;
  };

  const requireAccount = (accountId: string) => {
    if (!db.get("SELECT 1 FROM accounts WHERE id = ?", accountId)) throw notFound(`Account ${accountId}`);
  };

  const writeGrant = (agentId: string, g: GrantInput): Grant => {
    requireAccount(g.accountId);
    db.run(
      `INSERT INTO grants (id, agent_id, account_id, capabilities, label_scope, send_mode, allow_to, reply_only,
         max_sends_per_hour, max_sends_per_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, account_id) DO UPDATE SET
         capabilities = excluded.capabilities, label_scope = excluded.label_scope, send_mode = excluded.send_mode,
         allow_to = excluded.allow_to, reply_only = excluded.reply_only,
         max_sends_per_hour = excluded.max_sends_per_hour, max_sends_per_day = excluded.max_sends_per_day`,
      newId("grt"),
      agentId,
      g.accountId,
      json.str(g.capabilities),
      g.labelScope === null ? null : json.str(g.labelScope),
      g.sendMode,
      json.str(g.allowTo),
      g.replyOnly ? 1 : 0,
      g.maxSendsPerHour,
      g.maxSendsPerDay,
      now(),
    );
    return toGrant(db.get<GrantRow>("SELECT * FROM grants WHERE agent_id = ? AND account_id = ?", agentId, g.accountId)!);
  };

  const grantSummary = (g: GrantInput) => ({
    capabilities: g.capabilities,
    sendMode: g.sendMode,
    labelScope: g.labelScope,
    allowTo: g.allowTo.length,
    replyOnly: g.replyOnly,
    maxSendsPerHour: g.maxSendsPerHour,
    maxSendsPerDay: g.maxSendsPerDay,
  });

  return {
    authenticate(apiKey: string): AgentPrincipal | null {
      if (typeof apiKey !== "string" || !apiKey.startsWith(API_KEY_PREFIX) || apiKey.length > 200) return null;
      const r = db.get<AgentRow>("SELECT * FROM agents WHERE key_hash = ?", sha256(apiKey));
      if (!r || bool(r.disabled)) return null;
      const ts = Date.now();
      if (!r.last_used_at || ts - Date.parse(r.last_used_at) >= LAST_USED_THROTTLE_MS) {
        db.run("UPDATE agents SET last_used_at = ? WHERE id = ?", new Date(ts).toISOString(), r.id);
      }
      return { agentId: r.id, name: r.name };
    },

    listAgents() {
      return db.all<AgentRow>("SELECT * FROM agents ORDER BY created_at, id").map(toAgent);
    },

    getAgent(id) {
      const r = row(id);
      return r ? toAgent(r) : null;
    },

    createAgent(input: CreateAgentInput): AgentWithKey {
      const fields = parseAgentFields(input);
      if (!fields.name) throw badRequest("Name is required");
      const grants = (input.grants ?? []).map(parseGrantInput);
      const seen = new Set<string>();
      for (const g of grants) {
        if (seen.has(g.accountId)) throw badRequest(`Only one grant per account (duplicate ${g.accountId})`);
        seen.add(g.accountId);
      }
      const apiKey = newApiKey();
      const id = newId("agt");
      db.tx(() => {
        db.run(
          "INSERT INTO agents (id, name, description, key_prefix, key_hash, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
          id,
          fields.name!,
          fields.description || null,
          apiKey.slice(0, 8),
          sha256(apiKey),
          now(),
        );
        for (const g of grants) writeGrant(id, g);
      });
      ctx.audit.record({
        ...ADMIN_ACTOR,
        action: "agent.create",
        target: id,
        outcome: "ok",
        detail: { name: fields.name, grants: grants.map((g) => g.accountId) },
      });
      return { agent: toAgent(requireRow(id)), apiKey };
    },

    updateAgent(id, patch) {
      requireRow(id);
      const fields = parseAgentFields(patch);
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (fields.name !== undefined) {
        sets.push("name = ?");
        params.push(fields.name);
      }
      if (fields.description !== undefined) {
        sets.push("description = ?");
        params.push(fields.description || null);
      }
      if (fields.disabled !== undefined) {
        sets.push("disabled = ?");
        params.push(fields.disabled ? 1 : 0);
      }
      if (sets.length) db.run(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "agent.update", target: id, outcome: "ok", detail: { fields: Object.keys(fields) } });
      return toAgent(requireRow(id));
    },

    rotateKey(id) {
      requireRow(id);
      const apiKey = newApiKey();
      db.run("UPDATE agents SET key_prefix = ?, key_hash = ? WHERE id = ?", apiKey.slice(0, 8), sha256(apiKey), id);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "agent.rotate_key", target: id, outcome: "ok" });
      return { agent: toAgent(requireRow(id)), apiKey };
    },

    deleteAgent(id) {
      const r = requireRow(id);
      db.run("DELETE FROM agents WHERE id = ?", id);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "agent.delete", target: id, outcome: "ok", detail: { name: r.name } });
    },

    upsertGrant(agentId, accountId, input) {
      requireRow(agentId);
      const raw = { ...(input as object), accountId };
      if ((input as { accountId?: unknown }).accountId && (input as { accountId?: unknown }).accountId !== accountId) {
        throw badRequest("The grant's accountId does not match the URL");
      }
      const g = parseGrantInput(raw);
      const grant = writeGrant(agentId, g);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "grant.upsert", accountId, target: agentId, outcome: "ok", detail: grantSummary(g) });
      return grant;
    },

    deleteGrant(agentId, accountId) {
      requireRow(agentId);
      const { changes } = db.run("DELETE FROM grants WHERE agent_id = ? AND account_id = ?", agentId, accountId);
      if (!changes) throw notFound("Grant");
      ctx.audit.record({ ...ADMIN_ACTOR, action: "grant.delete", accountId, target: agentId, outcome: "ok" });
    },

    grant(agentId, accountId) {
      const r = db.get<GrantRow>("SELECT * FROM grants WHERE agent_id = ? AND account_id = ?", agentId, accountId);
      return r ? toGrant(r) : null;
    },

    grants: grantsOf,

    canSeeEvent(agentId, ev) {
      const r = db.get<GrantRow & { disabled: number }>(
        "SELECT g.*, a.disabled FROM grants g JOIN agents a ON a.id = g.agent_id WHERE g.agent_id = ? AND g.account_id = ?",
        agentId,
        ev.accountId,
      );
      if (!r || bool(r.disabled)) return false;
      const g = toGrant(r);
      if (!g.capabilities.includes("read")) return false;
      if (ACCOUNT_EVENTS.has(ev.type) || g.labelScope === null) return true;
      return ev.threadLabelIds.some((id) => g.labelScope!.includes(id));
    },
  };
}
