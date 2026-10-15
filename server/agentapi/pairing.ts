import { randomInt } from "node:crypto";
import { z } from "zod";
import type { PairingPoll, PairingStart } from "../../shared/agent-api.ts";
import { type Agent, type ApprovePairingInput, CAPABILITIES, type PairingRequest, type PairingStatus, SEND_MODES } from "../../shared/types.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { json } from "../db/index.ts";
import { grantInputSchema } from "../policy/grants.ts";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";

export interface PairingOptions {
  clock?: () => number;
  /** How long a code stays valid. Default 10 minutes. */
  ttlMs?: number;
  /** Minimum seconds between polls. Default 3. */
  intervalSeconds?: number;
  /** After approval the CLI always gets at least this long to collect the key. Default 2 minutes. */
  collectGraceMs?: number;
  /** Global cap on pending requests. Default 20. */
  maxPending?: number;
}

/** No 0/O, 1/I/L: easy to read aloud and compare. */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** 48 base32 chars = 240 bits. */
const DEVICE_CODE_CHARS = 48;
/** Slack for client timers and network jitter before a poll counts as too fast. */
const POLL_JITTER_MS = 250;

export const PAIRING_STATUSES: PairingStatus[] = ["pending", "approved", "denied", "expired"];

export const pairingStartSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80, "Name must be at most 80 characters"),
  description: z.string().trim().max(500).nullable().optional(),
  requested: z
    .object({
      accounts: z.array(z.string().trim().min(1).max(320)).max(50).optional(),
      capabilities: z.array(z.enum(CAPABILITIES)).optional(),
      sendMode: z.enum(SEND_MODES).optional(),
      reason: z.string().trim().max(500).optional(),
    })
    .optional(),
  client: z
    .object({
      hostname: z.string().max(255).optional(),
      platform: z.string().max(50).optional(),
      tool: z.string().max(40).optional(),
      version: z.string().max(50).optional(),
    })
    .optional(),
});

export const pollSchema = z.object({ deviceCode: z.string().min(1).max(200) });

export const approveSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  grants: z
    .array(grantInputSchema)
    .min(1, "Grant access to at least one account")
    .max(100) satisfies z.ZodType<ApprovePairingInput["grants"]>,
});

export const denySchema = z.object({ note: z.string().trim().max(500).nullable().optional() });

interface PairingRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  name: string;
  description: string | null;
  requested: string;
  client: string;
  ip: string | null;
  status: PairingStatus;
  agent_id: string | null;
  api_key_enc: string | null;
  last_poll_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  delivered_at: string | null;
  created_at: string;
  expires_at: string;
}

const toPairing = (r: PairingRow): PairingRequest => ({
  id: r.id,
  userCode: r.user_code,
  name: r.name,
  description: r.description,
  requested: json.parse(r.requested, {}),
  client: json.parse(r.client, {}),
  ip: r.ip,
  status: r.status,
  agentId: r.agent_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
});

export interface PairingService {
  readonly intervalSeconds: number;
  /** Whether the global cap on pending requests is reached. */
  full(): boolean;
  start(input: z.infer<typeof pairingStartSchema>, ip: string): PairingStart;
  /** Unknown device codes return null (the caller counts them toward the per-IP lockout). */
  poll(deviceCode: string): PairingPoll | null;
  list(status?: PairingStatus): PairingRequest[];
  get(id: string): PairingRequest | null;
  approve(id: string, input: z.infer<typeof approveSchema>): Agent;
  deny(id: string, note?: string | null): PairingRequest;
  /**
   * Expires overdue pending requests, and approved requests whose key was never collected: their
   * key is wiped and the agent created on approval is deleted, so no undelivered credential lingers.
   * Also prunes decided requests older than the retention period. Returns how many expired.
   */
  sweep(): number;
}

export function createPairingService(ctx: AppContext, opts: PairingOptions = {}): PairingService {
  const { db } = ctx;
  const clock = opts.clock ?? Date.now;
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const intervalSeconds = opts.intervalSeconds ?? 3;
  const graceMs = opts.collectGraceMs ?? 2 * 60_000;
  const maxPending = opts.maxPending ?? 20;
  const iso = (ms = clock()) => new Date(ms).toISOString();

  const row = (id: string) => db.get<PairingRow>("SELECT * FROM pairings WHERE id = ?", id);
  const publish = (id: string) => {
    const r = row(id);
    if (!r) return;
    try {
      ctx.bus.emit("pairing", toPairing(r));
    } catch (err) {
      ctx.log.error("Bus listener failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  const urls = () => {
    const base = ctx.settings.publicUrl();
    return { mcpUrl: `${base}/mcp`, skillUrl: `${base}/skill.md`, base };
  };

  function newUserCode(): string {
    for (;;) {
      let s = "";
      for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
      const code = `${s.slice(0, 4)}-${s.slice(4)}`;
      if (!db.get("SELECT 1 FROM pairings WHERE user_code = ? AND status IN ('pending', 'approved')", code)) return code;
    }
  }

  function sweep(): number {
    const t = iso();
    let expired = 0;
    for (const r of db.all<PairingRow>("SELECT * FROM pairings WHERE status = 'pending' AND expires_at <= ?", t)) {
      if (!db.run("UPDATE pairings SET status = 'expired' WHERE id = ? AND status = 'pending'", r.id).changes) continue;
      expired++;
      ctx.audit.record({ actorType: "system", action: "pairing.expired", target: r.id, outcome: "ok", detail: { userCode: r.user_code, name: r.name } });
      publish(r.id);
    }
    // Approved, but the CLI never came back for the key: remove the credential and its agent.
    for (const r of db.all<PairingRow>("SELECT * FROM pairings WHERE status = 'approved' AND api_key_enc IS NOT NULL AND expires_at <= ?", t)) {
      db.tx(() => {
        db.run("UPDATE pairings SET status = 'expired', api_key_enc = NULL WHERE id = ?", r.id);
        if (r.agent_id) db.run("DELETE FROM agents WHERE id = ?", r.agent_id);
      });
      expired++;
      ctx.audit.record({
        actorType: "system",
        action: "pairing.expired",
        target: r.id,
        outcome: "ok",
        detail: { userCode: r.user_code, name: r.name, keyCollected: false, agentDeleted: r.agent_id },
      });
      if (r.agent_id) ctx.bus.emit("agent", { agentId: r.agent_id, reason: "deleted" });
      publish(r.id);
    }
    const before = iso(clock() - ctx.settings.get().retentionDays * 86_400_000);
    db.run("DELETE FROM pairings WHERE status IN ('denied', 'expired', 'approved') AND api_key_enc IS NULL AND created_at < ?", before);
    return expired;
  }

  function requirePending(id: string): PairingRow {
    sweep();
    const r = row(id);
    if (!r) throw notFound("Pairing request");
    if (r.status !== "pending") {
      throw new HttpError(409, "conflict", `This pairing request is already ${r.status}`, "Run `npx agentinbox-cli connect` again to start a new one.");
    }
    return r;
  }

  return {
    intervalSeconds,

    full() {
      return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending' AND expires_at > ?", iso())!.n >= maxPending;
    },

    start(input, ip) {
      const deviceCode = randomToken(DEVICE_CODE_CHARS);
      const userCode = newUserCode();
      const id = newId("par");
      const t = clock();
      const expiresAt = iso(t + ttlMs);
      db.run(
        `INSERT INTO pairings (id, device_code_hash, user_code, name, description, requested, client, ip, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id,
        sha256(deviceCode),
        userCode,
        input.name,
        input.description || null,
        json.str(input.requested ?? {}),
        json.str(input.client ?? {}),
        ip,
        iso(t),
        expiresAt,
      );
      ctx.audit.record({
        actorType: "system",
        action: "pairing.requested",
        target: id,
        outcome: "ok",
        detail: { userCode, name: input.name, ip, tool: input.client?.tool ?? null, hostname: input.client?.hostname ?? null },
      });
      publish(id);
      return {
        deviceCode,
        userCode,
        verificationUrl: `${urls().base}/approvals?pairing=${userCode}`,
        expiresAt,
        interval: intervalSeconds,
      };
    },

    poll(deviceCode) {
      const found = db.get<PairingRow>("SELECT * FROM pairings WHERE device_code_hash = ?", sha256(deviceCode));
      if (!found) return null;
      const t = clock();
      if (found.last_poll_at && t - Date.parse(found.last_poll_at) < intervalSeconds * 1000 - POLL_JITTER_MS) {
        return { status: "slow_down", interval: intervalSeconds };
      }
      db.run("UPDATE pairings SET last_poll_at = ? WHERE id = ?", iso(t), found.id);
      if (found.expires_at <= iso(t)) sweep();
      const r = row(found.id)!;
      switch (r.status) {
        case "pending":
          return { status: "pending" };
        case "denied":
          return { status: "denied", note: r.decision_note };
        case "expired":
          return { status: "expired" };
        case "approved":
          break;
      }
      if (r.delivered_at) return { status: "consumed" };
      const agent = r.agent_id ? db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE id = ?", r.agent_id) : undefined;
      // Exactly once: only the poll that clears the ciphertext gets the key.
      const claimed = db.run("UPDATE pairings SET api_key_enc = NULL, delivered_at = ? WHERE id = ? AND api_key_enc IS NOT NULL", iso(t), r.id).changes;
      if (!claimed || !r.api_key_enc) return { status: "expired" };
      if (!agent) {
        // The agent was deleted in the console before the CLI collected its key.
        db.run("UPDATE pairings SET status = 'expired', delivered_at = NULL WHERE id = ?", r.id);
        publish(r.id);
        return { status: "expired" };
      }
      const apiKey = ctx.crypto.decrypt(r.api_key_enc);
      ctx.audit.record({ actorType: "agent", actorId: agent.id, action: "pairing.key_delivered", target: r.id, outcome: "ok", detail: { userCode: r.user_code } });
      publish(r.id);
      const { mcpUrl, skillUrl } = urls();
      return { status: "approved", apiKey, agent: { id: agent.id, name: agent.name }, mcpUrl, skillUrl };
    },

    list(status) {
      sweep();
      const rows = status
        ? db.all<PairingRow>("SELECT * FROM pairings WHERE status = ? ORDER BY created_at DESC, id LIMIT 200", status)
        : db.all<PairingRow>("SELECT * FROM pairings ORDER BY created_at DESC, id LIMIT 200");
      return rows.map(toPairing);
    },

    get(id) {
      const r = row(id);
      return r ? toPairing(r) : null;
    },

    approve(id, input) {
      const r = requirePending(id);
      const seen = new Set<string>();
      for (const g of input.grants) {
        if (seen.has(g.accountId)) throw badRequest(`Only one grant per account (duplicate ${g.accountId})`);
        seen.add(g.accountId);
      }
      const t = clock();
      const agentId = db.tx(() => {
        const { agent, apiKey } = ctx.policy.createAgent({ name: input.name ?? r.name, description: r.description, grants: input.grants });
        const changes = db.run(
          `UPDATE pairings SET status = 'approved', agent_id = ?, api_key_enc = ?, decided_at = ?, expires_at = ?
           WHERE id = ? AND status = 'pending'`,
          agent.id,
          ctx.crypto.encrypt(apiKey),
          iso(t),
          iso(Math.max(Date.parse(r.expires_at), t + graceMs)),
          id,
        ).changes;
        if (!changes) throw new HttpError(409, "conflict", "This pairing request was decided meanwhile");
        return agent.id;
      });
      ctx.audit.record({
        ...ADMIN_ACTOR,
        action: "pairing.approved",
        target: id,
        outcome: "ok",
        detail: { userCode: r.user_code, agentId, grants: input.grants.map((g) => ({ accountId: g.accountId, capabilities: g.capabilities, sendMode: g.sendMode })) },
      });
      publish(id);
      return ctx.policy.getAgent(agentId)!;
    },

    deny(id, note) {
      const r = requirePending(id);
      db.run("UPDATE pairings SET status = 'denied', decided_at = ?, decision_note = ? WHERE id = ?", iso(), note || null, id);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "pairing.denied", target: id, outcome: "ok", detail: { userCode: r.user_code, name: r.name } });
      publish(id);
      return toPairing(row(id)!);
    },

    sweep,
  };
}
