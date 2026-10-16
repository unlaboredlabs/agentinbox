// The MCP broker as an AppContext service (docs/MCP-BROKER.md). It holds one ToolSource per connection, the
// tool registry, the policy's call path and the connector, and owns the lifecycle and the kill switch.
//
// The parts come from other workstreams (server/broker/types.ts lists who builds what). Until each one is
// wired, its default here is an inert stub: no tools, calls answered with isError, probes that report
// "not available". Tests pass fakes through createBrokerService(ctx, parts).
//
// Everything is behind Settings.brokerUpstreams (off by default): with it off, `view` is null, /mcp lists
// only the native tools, connection events are invisible and /api/connections answers 404.

import type {
  AccessLevel,
  Connection,
  ConnectionAuthType,
  ConnectionProbe,
  ConnectionView,
  EventType,
  MailEvent,
  McpCallApproval,
  StartConnectInput,
  StartConnectResult,
} from "../../shared/types.ts";
import type { AppContext, Lifecycle } from "../context.ts";
import { now } from "../db/index.ts";
import { presets } from "../integrations/index.ts";
import { Approvals } from "../mail/approvals.ts";
import { conflict, errorMessage, notFound } from "../util/errors.ts";
import { type ConnectionGrantRef, connectionGrantsOf } from "./access.ts";
import {
  type BrokerCalls,
  type IntegrationPreset,
  type NativeSourceDeps,
  type RegisteredTool,
  SourceError,
  type ToolRegistry,
  type ToolResult,
  type ToolSource,
} from "./types.ts";

// ───────────── Parts other workstreams provide ─────────────

/** StartConnectResult without the view (the API adds the fresh ConnectionView on "connected"). */
export type ConnectOutcome = Exclude<StartConnectResult, { status: "connected" }> | { status: "connected" };

/** The upstream runtime's entry points (server/broker/upstream/*). Stubbed until that branch lands. */
export interface Connector {
  /** Probes an MCP URL: reachable, which auth, blocked by the SSRF guard. Never stores anything. */
  probe(input: { url: string; privateTarget: string | null }, signal: AbortSignal): Promise<ConnectionProbe>;
  /** Starts connecting: stores a static header, or begins OAuth and returns the authorize URL. */
  startConnect(connection: Connection, input: StartConnectInput, signal: AbortSignal): Promise<ConnectOutcome>;
  /** The ToolSource for a remote_http connection. */
  createSource(connection: Connection): ToolSource;
}

export interface BrokerParts {
  /** Catalog (server/broker/catalog/*). */
  registry: ToolRegistry;
  /** Policy and approvals (server/broker/policy/*): the single call path. */
  calls: BrokerCalls;
  /** get_call_status(approval_id), from the policy workstream. */
  callStatus(agentId: string, approvalId: string): ToolResult | Promise<ToolResult>;
  /**
   * Runs an approved mcp.call (re-checks agent, grant, pin and args hash, then forwards the stored bytes).
   * Approvals.approve calls it after claiming the approval. Absent: approving an mcp.call is refused (409).
   */
  runApprovedCall?(approval: McpCallApproval, signal: AbortSignal): Promise<ToolResult>;
  connector: Connector;
  /** Native presets' source dependencies (credential store + token refresher). */
  nativeDeps?(connection: Connection): NativeSourceDeps;
  /** Accepts a held tool (re-pin + re-classify). Absent: the fallback re-pins the candidate as is. */
  acceptTool?(connectionId: string, name: string): void;
  /** Kill switch extras, run before the credentials are deleted (e.g. RFC 7009 revoke, untrack refresh). */
  onKill?: ((connectionId: string) => void | Promise<void>)[];
  /** The preset registry; default server/integrations presets(). */
  presets?: () => IntegrationPreset[];
}

// ───────────── The service ─────────────

/** What one agent gets from the broker on /mcp. */
export interface AgentBrokerView {
  /** The agent's connection grants (any level), by slug. */
  connections: ConnectionGrantRef[];
  /** Tools from ToolRegistry.forAgent: levels applied, held tools excluded. */
  tools: RegisteredTool[];
}

export interface BrokerService extends Lifecycle {
  /** Settings.brokerUpstreams. */
  enabled(): boolean;
  /** null while the broker is off. */
  view(agentId: string): AgentBrokerView | null;
  calls: BrokerCalls;
  callStatus(agentId: string, approvalId: string): Promise<ToolResult>;
  canRunApprovedCalls(): boolean;
  runApprovedCall(approval: McpCallApproval, signal: AbortSignal): Promise<ToolResult>;
  /** The connection's source, created on first use; null when the connection is missing or disabled, or the broker is off. */
  source(connectionId: string): ToolSource | null;
  connector: Connector;
  presets(): IntegrationPreset[];
  /** Closes the connection's source (after its URL or credential changed); the next use builds a new one. */
  reload(connectionId: string): Promise<void>;
  /** Kill switch: disable, cancel pending calls, close the source, run onKill, delete the credentials. Audited. */
  kill(connectionId: string, reason: string): Promise<void>;
  /** The kill switch, then the row (grants, pins, rules and approvals cascade). Audited. */
  remove(connectionId: string): Promise<void>;
  acceptTool(connectionId: string, name: string): void;
  /** Emits a connection event (connection.*, approval.requested, `<preset>.*`) through the events outbox. */
  emitConnectionEvent(e: { type: EventType; connectionId: string; dedupeKey: string; detail?: Record<string, unknown> }): MailEvent | null;
}

const UNAVAILABLE = "Integrations aren't available in this build of agentinbox yet.";
const unavailable = (): ToolResult => ({ isError: true, content: [{ type: "text", text: UNAVAILABLE }] });

/** Inert defaults: used for any part not passed in (see the header). */
export function stubParts(): BrokerParts {
  return {
    registry: { forAgent: () => [], resolve: () => null },
    calls: { call: async () => unavailable() },
    callStatus: () => unavailable(),
    connector: {
      probe: async () => ({ reachable: false, auth: "unknown", message: UNAVAILABLE }),
      startConnect: async () => ({ status: "error", message: UNAVAILABLE }),
      createSource: (c) => unavailableSource(c.id),
    },
  };
}

function unavailableSource(connectionId: string): ToolSource {
  return {
    connectionId,
    listTools: async () => {
      throw new SourceError("unavailable", UNAVAILABLE);
    },
    callTool: async () => unavailable(),
    close: async () => {},
  };
}

export function createBrokerService(ctx: AppContext, given: Partial<BrokerParts> = {}): BrokerService {
  const parts: BrokerParts = { ...stubParts(), ...given };
  const log = ctx.log.child("broker");
  const sources = new Map<string, ToolSource>();
  const approvals = new Approvals(ctx);
  const enabled = () => ctx.settings.get().brokerUpstreams;

  const closeSource = async (connectionId: string) => {
    const s = sources.get(connectionId);
    sources.delete(connectionId);
    await s?.close().catch((err: unknown) => log.warn("Closing a tool source failed", { connection: connectionId, error: errorMessage(err) }));
  };
  const closeAll = async () => {
    await Promise.all([...sources.keys()].map(closeSource));
  };

  function createSource(c: Connection): ToolSource {
    if (c.kind === "remote_http") return parts.connector.createSource(c);
    const preset = c.preset ? ((parts.presets ?? presets)().find((p) => p.id === c.preset) ?? null) : null;
    if (!preset?.createSource) return unavailableSource(c.id);
    return preset.createSource(parts.nativeDeps?.(c) ?? defaultNativeDeps(c));
  }

  function defaultNativeDeps(c: Connection): NativeSourceDeps {
    return {
      connectionId: c.id,
      accessToken: async () => {
        throw new SourceError("needs_reauth", `The owner must reconnect ${c.name} in agentinbox (Connections → Reconnect).`);
      },
      fetch: globalThis.fetch,
      log: { info: (msg, meta) => log.info(msg, meta), warn: (msg, meta) => log.warn(msg, meta) },
    };
  }

  const onSettings = (s: { brokerUpstreams: boolean }) => {
    if (!s.brokerUpstreams && sources.size) void closeAll();
  };

  return {
    enabled,

    view(agentId) {
      if (!enabled()) return null;
      const connections = connectionGrantsOf(ctx.db, agentId);
      return { connections, tools: connections.length ? parts.registry.forAgent(agentId) : [] };
    },

    calls: {
      call: (agentId, exposedName, args, signal) => (enabled() ? parts.calls.call(agentId, exposedName, args, signal) : Promise.resolve(unavailable())),
    },

    async callStatus(agentId, approvalId) {
      return parts.callStatus(agentId, approvalId);
    },

    canRunApprovedCalls: () => !!parts.runApprovedCall,

    async runApprovedCall(approval, signal) {
      if (!parts.runApprovedCall) throw conflict("Tool call requests can't be approved by this version.", "Update agentinbox, or reject the request.");
      return parts.runApprovedCall(approval, signal);
    },

    source(connectionId) {
      if (!enabled()) return null;
      const existing = sources.get(connectionId);
      if (existing) return existing;
      const c = getConnection(ctx, connectionId);
      if (!c || c.status === "disabled") return null;
      const s = createSource(c);
      sources.set(connectionId, s);
      return s;
    },

    connector: parts.connector,
    presets: () => (parts.presets ?? presets)(),
    reload: closeSource,

    async kill(connectionId, reason) {
      const c = getConnection(ctx, connectionId);
      if (!c) throw notFound("Connection");
      ctx.db.run("UPDATE connections SET status = 'disabled', status_reason = ?, updated_at = ? WHERE id = ?", reason, now(), connectionId);
      const cancelled = approvals.cancelForConnection(connectionId, null, `the connection ${c.name} was disabled`);
      await closeSource(connectionId);
      for (const hook of parts.onKill ?? []) {
        try {
          await hook(connectionId);
        } catch (err) {
          log.warn("A kill switch hook failed", { connection: connectionId, error: errorMessage(err) });
        }
      }
      ctx.db.run("DELETE FROM connection_credentials WHERE connection_id = ?", connectionId);
      ctx.audit.record({ actorType: "admin", actorId: null, action: "connection.kill", target: connectionId, outcome: "ok", detail: { slug: c.slug, cancelled } });
    },

    async remove(connectionId) {
      const c = getConnection(ctx, connectionId);
      if (!c) throw notFound("Connection");
      const agents = ctx.db.all<{ agent_id: string }>("SELECT agent_id FROM connection_grants WHERE connection_id = ?", connectionId);
      await this.kill(connectionId, "deleted");
      ctx.db.run("DELETE FROM connections WHERE id = ?", connectionId);
      ctx.audit.record({ actorType: "admin", actorId: null, action: "connection.delete", target: connectionId, outcome: "ok", detail: { slug: c.slug } });
      for (const { agent_id } of agents) notifyAgent(ctx, agent_id);
    },

    acceptTool(connectionId, name) {
      if (parts.acceptTool) return parts.acceptTool(connectionId, name);
      const { changes } = ctx.db.run(
        `UPDATE upstream_tools SET definition = candidate_definition, pin_hash = candidate_hash, candidate_definition = NULL,
           candidate_hash = NULL, state = 'active', held_reason = NULL, updated_at = ? WHERE connection_id = ? AND name = ? AND state = 'held'`,
        now(),
        connectionId,
        name,
      );
      if (!changes) throw notFound("Held tool");
    },

    emitConnectionEvent(e) {
      return ctx.events.emit({ type: e.type, connectionId: e.connectionId, dedupeKey: e.dedupeKey, detail: e.detail });
    },

    start() {
      ctx.bus.on("settings", onSettings);
    },

    async stop() {
      ctx.bus.off("settings", onSettings);
      await closeAll();
    },
  };
}

/** Live streams re-check access (accessProblem counts connection grants) and the console refreshes the agent. */
export function notifyAgent(ctx: AppContext, agentId: string): void {
  try {
    ctx.bus.emit("agent", { agentId, reason: "grant_changed" });
  } catch (err) {
    ctx.log.error("Bus listener failed", { error: errorMessage(err) });
  }
  ctx.policy.publishAgent(agentId);
}

// ───────────── Connections table (migration 8) ─────────────

interface ConnectionRow {
  id: string;
  owner_id: string | null;
  kind: Connection["kind"];
  preset: Connection["preset"];
  slug: string;
  name: string;
  url: string | null;
  auth_type: ConnectionAuthType;
  level_default: AccessLevel;
  private_target: string | null;
  status: Connection["status"];
  status_reason: string | null;
  expires_at: string | null;
  protocol: string | null;
  tools_cached_at: string | null;
  instructions_hash: string | null;
  created_at: string;
  updated_at: string;
}

function toConnection(r: ConnectionRow): Connection {
  return {
    id: r.id,
    ownerId: r.owner_id,
    kind: r.kind,
    preset: r.preset,
    slug: r.slug,
    name: r.name,
    url: r.url,
    authType: r.auth_type,
    levelDefault: r.level_default,
    privateTarget: r.private_target,
    status: r.status,
    statusReason: r.status_reason,
    expiresAt: r.expires_at,
    protocol: r.protocol,
    toolsCachedAt: r.tools_cached_at,
    instructionsHash: r.instructions_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getConnection(ctx: Pick<AppContext, "db">, id: string): Connection | null {
  const r = ctx.db.get<ConnectionRow>("SELECT * FROM connections WHERE id = ?", id);
  return r ? toConnection(r) : null;
}

export function listConnections(ctx: Pick<AppContext, "db">): Connection[] {
  return ctx.db.all<ConnectionRow>("SELECT * FROM connections ORDER BY created_at, rowid").map(toConnection);
}

const DAY_MS = 86_400_000;

/** The list/get shape: tool counts, held count, agents and days to expiry. */
export function connectionView(ctx: Pick<AppContext, "db">, c: Connection, at = Date.now()): ConnectionView {
  const t = ctx.db.get<{ total: number; held: number | null }>(
    "SELECT COUNT(*) AS total, SUM(state = 'held') AS held FROM upstream_tools WHERE connection_id = ?",
    c.id,
  )!;
  const agents = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connection_grants WHERE connection_id = ?", c.id)!.n;
  const held = t.held ?? 0;
  const expiresInDays = c.expiresAt ? Math.max(0, Math.floor((Date.parse(c.expiresAt) - at) / DAY_MS)) : null;
  return { ...c, tools: { total: t.total, active: t.total - held, held }, expiresInDays, agents };
}
