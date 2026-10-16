// The MCP broker as an AppContext service (docs/MCP-BROKER.md). It holds one ToolSource per connection, the
// tool registry, the policy's call path and the connector, and owns the lifecycle and the kill switch.
//
// The parts come from other workstreams (server/broker/types.ts lists who builds what). The policy runtime
// (server/broker/policy) is built here and supplies calls, get_call_status, approved-call execution and the kill
// switch; the credential store falls back to a plain table store. Parts not wired yet (catalog registry, upstream
// connector) are inert stubs: no tools, probes that report "not available". Tests pass fakes through
// createBrokerService(ctx, parts).
//
// Everything is behind Settings.brokerUpstreams (off by default): with it off, `view` is null, /mcp lists
// only the native tools, connection events are invisible and /api/connections answers 404.

import {
  type AccessLevel,
  type Connection,
  type ConnectionAuthType,
  type ConnectionProbe,
  type ConnectionView,
  type EventType,
  isPresetEventType,
  type MailEvent,
  type McpCallApproval,
  type StartConnectInput,
  type StartConnectResult,
} from "../../shared/types.ts";
import type { AppContext, Lifecycle } from "../context.ts";
import { now } from "../db/index.ts";
import { type ConnectionHookHost, connectionHookUrl } from "../integrations/hooks.ts";
import { presets } from "../integrations/index.ts";
import { Approvals } from "../mail/approvals.ts";
import { conflict, errorMessage, notFound } from "../util/errors.ts";
import { type ConnectionGrantRef, connectionGrantsOf } from "./access.ts";
import { tableCredentials } from "./credentials-table.ts";
import { type BrokerPolicyRuntime, createBrokerPolicyRuntime } from "./policy/index.ts";
import {
  type BrokerCalls,
  type CredentialStore,
  type IntegrationEvent,
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
   * Runs an mcp.call approval already claimed ("approved"): re-checks agent, grant, pin and args hash, forwards
   * the stored bytes and records the outcome on the approval (sent with the result, back to pending, or failed
   * with an unknown outcome). Approvals.approve calls it after claiming. Default: the policy runtime.
   */
  runApprovedCall?(approval: McpCallApproval): Promise<void>;
  connector: Connector;
  /** Native presets' source dependencies (credential store + token refresher). */
  nativeDeps?(connection: Connection): NativeSourceDeps;
  /** Accepts a held tool (re-pin + re-classify). Absent: the fallback re-pins the candidate as is. */
  acceptTool?(connectionId: string, name: string): void;
  /** Kill switch extras, run after the policy's kill (e.g. RFC 7009 revoke). */
  onKill?: ((connectionId: string) => void | Promise<void>)[];
  /** The preset registry; default server/integrations presets(). */
  presets?: () => IntegrationPreset[];
  /** The credential store. Absent: tableCredentials (no refresh logic) until server/broker/credentials lands. */
  credentials?: CredentialStore;
}

export interface BrokerOptions {
  /** How often the native-preset event poll checks which connections are due (each polls every pollIntervalMs). Default 60 s. */
  pollTickMs?: number;
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
  runApprovedCall(approval: McpCallApproval): Promise<void>;
  /** The policy runtime (also reachable as brokerPolicyOf(ctx)). */
  policy: BrokerPolicyRuntime;
  /** A connection grant changed level (admin API): the policy re-checks pending calls. */
  onGrantChanged(agentId: string, connectionId: string): void;
  /** A connection grant was removed: pending calls cancelled, "always allow" rules deleted. */
  onGrantRemoved(agentId: string, connectionId: string): void;
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
  /** Inbound webhooks of native presets (POST /hooks/connections/:id, server/integrations/hooks.ts). */
  hooks: ConnectionHookHost;
  /** The connection's inbound webhook URL, or null without a public https URL (then its events are polled). */
  webhookUrl(connectionId: string): string | null;
  /** Polls every due native connection without a webhook URL once; returns the number of events emitted. */
  pollEvents(at?: number): Promise<number>;
}

const UNAVAILABLE = "Integrations aren't available in this build of agentinbox yet.";
const unavailable = (): ToolResult => ({ isError: true, content: [{ type: "text", text: UNAVAILABLE }] });

/** Inert defaults for parts not wired yet (see the header); calls and call status come from the policy runtime. */
export function stubParts(): Pick<BrokerParts, "registry" | "connector"> {
  return {
    registry: { forAgent: () => [], resolve: () => null },
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

export function createBrokerService(ctx: AppContext, given: Partial<BrokerParts> = {}, opts: BrokerOptions = {}): BrokerService {
  const base = { ...stubParts(), ...given };
  const log = ctx.log.child("broker");
  const sources = new Map<string, ToolSource>();
  const approvals = new Approvals(ctx);
  const enabled = () => ctx.settings.get().brokerUpstreams;
  const credentials = given.credentials ?? tableCredentials(ctx);

  // The policy runtime (W6): BrokerCalls, get_call_status, approved calls, grant hooks and the kill switch.
  const policy = createBrokerPolicyRuntime(ctx, {
    registry: base.registry,
    sources: { source: (id) => service.source(id), close: (id) => closeSource(id) },
    credentials,
    onApprovalRequested: (ev) => {
      try {
        const { type, connectionId, ...detail } = ev;
        ctx.events.emit({ type, connectionId, dedupeKey: `${type}:${ev.approvalId}`, detail });
      } catch (err) {
        log.error("approval.requested event failed", { error: errorMessage(err) });
      }
    },
  });
  const parts: BrokerParts = {
    calls: policy,
    callStatus: (agentId, id) => policy.getCallStatus(agentId, id),
    runApprovedCall: (approval) => policy.runApprovedCall(approval),
    ...base,
  };

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
    const preset = presetOf(c);
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

  const presetOf = (c: Connection): IntegrationPreset | null => (c.preset ? ((parts.presets ?? presets)().find((p) => p.id === c.preset) ?? null) : null);

  /** The client registration (e.g. WHOOP's pasted client id and secret). */
  const clientRecord = (connectionId: string): Record<string, unknown> | null => credentials.client(connectionId);

  /** Native preset events into the outbox: only the preset's own `<id>.*` types, only for that connection. */
  function emitIntegrationEvents(connection: Connection, preset: IntegrationPreset, events: IntegrationEvent[]): number {
    let n = 0;
    for (const e of events) {
      if (e.connectionId !== connection.id || !e.type.startsWith(`${preset.id}.`) || !isPresetEventType(e.type)) {
        log.warn("Dropped an integration event", { connection: connection.id, type: e.type.slice(0, 80) });
        continue;
      }
      if (ctx.events.emit({ type: e.type, connectionId: connection.id, dedupeKey: `${connection.id}:${e.dedupeKey}`, detail: e.data })) n++;
    }
    return n;
  }

  const hooks: ConnectionHookHost = {
    webhookTarget(connectionId) {
      const c = getConnection(ctx, connectionId);
      if (!c || c.status === "disabled" || c.status === "needs_reauth") return null;
      const preset = presetOf(c);
      if (!preset?.events?.handleWebhook || preset.auth.type !== "user_app") return null;
      const secret = clientRecord(connectionId)?.[preset.auth.clientSecretInput];
      if (typeof secret !== "string" || !secret) return null;
      return { preset, deps: parts.nativeDeps?.(c) ?? defaultNativeDeps(c), clientSecret: secret, client: clientRecord(connectionId) };
    },
    emit(events) {
      const byConnection = new Map<string, IntegrationEvent[]>();
      for (const e of events) byConnection.set(e.connectionId, [...(byConnection.get(e.connectionId) ?? []), e]);
      for (const [id, list] of byConnection) {
        const c = getConnection(ctx, id);
        const preset = c ? presetOf(c) : null;
        if (c && preset) emitIntegrationEvents(c, preset, list);
      }
    },
  };

  const webhookUrl = (connectionId: string): string | null => {
    const publicUrl = ctx.settings.publicUrl();
    return publicUrl.startsWith("https://") ? connectionHookUrl(publicUrl, connectionId) : null;
  };

  const lastPoll = new Map<string, number>();
  let polling = false;
  async function pollEvents(at = Date.now()): Promise<number> {
    if (polling || !enabled()) return 0;
    polling = true;
    let emitted = 0;
    try {
      for (const c of listConnections(ctx)) {
        if (c.kind === "remote_http" || c.status === "disabled" || c.status === "needs_reauth" || webhookUrl(c.id)) continue;
        const preset = presetOf(c);
        const poll = preset?.events?.poll;
        if (!preset || !poll) continue;
        const interval = preset.events?.pollIntervalMs ?? 15 * 60_000;
        if (at - (lastPoll.get(c.id) ?? 0) < interval) continue;
        lastPoll.set(c.id, at);
        try {
          const cursor = ctx.db.get<{ events_cursor: string | null }>("SELECT events_cursor FROM connections WHERE id = ?", c.id)?.events_cursor ?? null;
          const r = await poll(cursor, parts.nativeDeps?.(c) ?? defaultNativeDeps(c));
          emitted += emitIntegrationEvents(c, preset, r.events);
          ctx.db.run("UPDATE connections SET events_cursor = ? WHERE id = ?", r.cursor, c.id);
        } catch (err) {
          log.warn("Integration event poll failed", { connection: c.id, error: errorMessage(err) });
        }
      }
    } finally {
      polling = false;
    }
    return emitted;
  }
  let pollTimer: NodeJS.Timeout | null = null;

  const service: BrokerService = {
    enabled,
    policy,
    onGrantChanged: (agentId, connectionId) => void policy.onGrantChanged(agentId, connectionId),
    onGrantRemoved: (agentId, connectionId) => void policy.onGrantRemoved(agentId, connectionId),

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

    async runApprovedCall(approval) {
      if (!parts.runApprovedCall) throw conflict("Tool call requests can't be approved by this version.", "Update agentinbox, or reject the request.");
      return parts.runApprovedCall(approval);
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
      // The policy's kill: disable, cancel pending calls, clear credentials, untrack refresh, close the source. Audited.
      await policy.killConnection(connectionId);
      if (reason) ctx.db.run("UPDATE connections SET status_reason = ?, updated_at = ? WHERE id = ?", reason, now(), connectionId);
      // Belt and braces for approvals the policy doesn't own (none today) and a source opened meanwhile.
      approvals.cancelForConnection(connectionId, null, `the connection ${c.name} was disabled`);
      await closeSource(connectionId);
      for (const hook of parts.onKill ?? []) {
        try {
          await hook(connectionId);
        } catch (err) {
          log.warn("A kill switch hook failed", { connection: connectionId, error: errorMessage(err) });
        }
      }
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

    hooks,
    webhookUrl,
    pollEvents,

    start() {
      policy.start();
      ctx.bus.on("settings", onSettings);
      pollTimer = setInterval(() => void pollEvents(), opts.pollTickMs ?? 60_000);
      pollTimer.unref();
    },

    async stop() {
      ctx.bus.off("settings", onSettings);
      if (pollTimer) clearInterval(pollTimer);
      await closeAll();
    },
  };
  return service;
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
