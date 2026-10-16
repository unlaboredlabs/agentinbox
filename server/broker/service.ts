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
import { conflict, errorMessage, HttpError, notFound } from "../util/errors.ts";
import { randomToken } from "../util/ids.ts";
import { type ConnectionGrantRef, connectionGrantsOf } from "./access.ts";
import { brokerConnections, Catalog, CatalogError, CatalogRegistry, connectionGrants, SqliteCatalogStore } from "./catalog/index.ts";
import { nativeDepsFor, registerNativeFlows, upstreamConnector } from "./connector.ts";
import { upstreams } from "./upstream/runtime.ts";
import { type BrokerPolicyRuntime, brokerPolicyOf, createBrokerPolicyRuntime } from "./policy/index.ts";
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

/** The upstream runtime's entry points (server/broker/upstream/*), adapted in server/broker/connector.ts. */
export interface Connector {
  /** Probes an MCP URL: reachable, which auth, blocked by the SSRF guard. Never stores anything. */
  probe(input: { url: string; privateTarget: string | null }, signal: AbortSignal): Promise<ConnectionProbe>;
  /** Starts connecting: stores a static header, or begins OAuth and returns the authorize URL. */
  startConnect(connection: Connection, input: StartConnectInput, signal: AbortSignal): Promise<ConnectOutcome>;
  /** The ToolSource for a remote_http connection. */
  createSource(connection: Connection): ToolSource;
  /** Paste mode: finishes a sign-in from the landing URL the user copied. */
  finishFromUrl?(raw: string): Promise<{ status: "connected"; connectionId: string } | { status: "error"; message: string; connectionId: null }>;
  /** Drops the pooled session and fetch (URL or allow edited, reconnect, kill, delete). */
  invalidate?(connectionId: string): Promise<void>;
  /** Closes the session, stops refreshing and deletes every credential (URL edit). */
  disconnect?(connectionId: string): Promise<void>;
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
  /** Accepts a held tool (re-pin + re-classify), only if its candidate still has this hash. Default: the catalog. */
  acceptTool?(connectionId: string, name: string, candidateHash: string): void;
  /**
   * Drops cached per-agent tool views after connections, slugs, grants or pins changed. Default: the catalog
   * registry's invalidate (whole cache, or one agent's view).
   */
  invalidate?(scope: InvalidateScope): void;
  /** Kill switch extras, run before the credentials are cleared (e.g. RFC 7009 revoke needs the token). */
  onKill?: ((connectionId: string) => void | Promise<void>)[];
  /** The preset registry; default server/integrations presets(). */
  presets?: () => IntegrationPreset[];
  /** The credential store. Default: the upstream runtime's (server/broker/credentials). */
  credentials?: CredentialStore;
}

/** What changed: one agent's grants, one connection (slug, URL, pins, kill), or everything. */
export type InvalidateScope = { agentId: string } | { connectionId: string } | "all";

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
  /** Kill switch: disable, run onKill, then the policy's kill (cancel pending calls, clear credentials, close the source). Audited. */
  kill(connectionId: string, reason: string): Promise<void>;
  /** The kill switch, then the row (grants, pins, rules and approvals cascade). Audited. */
  remove(connectionId: string): Promise<void>;
  /** Accepts a held tool; 409 when the candidate changed since `candidateHash` was shown, 404 when nothing is held. */
  acceptTool(connectionId: string, name: string, candidateHash: string): void;
  invalidate(scope: InvalidateScope): void;
  /** The pinned catalog (W5). */
  catalog: Catalog;
  /** (Re)starts the catalog's tool listing for a connection (create, connect, URL change); no-op while off or disabled. */
  attach(connectionId: string): void;
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

/** Inert parts, for tests that don't want the catalog or the upstream runtime. */
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
  const log = ctx.log.child("broker");
  const sources = new Map<string, ToolSource>();
  const enabled = () => ctx.settings.get().brokerUpstreams;
  const presetList = () => (given.presets ?? presets)();
  const presetFor = (presetId: string | null) => (presetId ? (presetList().find((p) => p.id === presetId) ?? null) : null);

  // The upstream runtime (W3/W4): credential store, refresher, connect flow, remote sources. Created here, first,
  // so its connection events go to the outbox; native OAuth flows are registered before start() runs.
  const up = upstreams(ctx, {
    emit: (e) => {
      try {
        ctx.events.emit({ type: e.type, connectionId: e.connectionId, dedupeKey: e.dedupeKey, detail: e.detail });
      } catch (err) {
        log.error(`${e.type} event failed`, { error: errorMessage(err) });
      }
    },
  });
  registerNativeFlows(up);
  const credentials = given.credentials ?? up.store;

  // The catalog (W5): pins, holds and the per-agent registry over upstream_tools.
  const store = new SqliteCatalogStore(ctx.db);
  const catalog = new Catalog({
    store,
    connection: (id) => {
      const c = getConnection(ctx, id);
      return c ? { slug: c.slug, preset: presetFor(c.preset) } : null;
    },
    connections: () => brokerConnections(ctx.db).map((c) => ({ id: c.id, slug: c.slug })),
    audit: (input) => ctx.audit.record(input),
    emit: (ev) => {
      const { type, connectionId, ...detail } = ev;
      ctx.events.emit({ type, connectionId, dedupeKey: `${connectionId}:${type}:${randomToken(12)}`, detail });
    },
    log,
    enabled,
  });
  const catalogRegistry = new CatalogRegistry({
    store,
    connections: () => brokerConnections(ctx.db),
    grants: (agentId) => connectionGrants(ctx.db, agentId),
    preset: (id) => presetFor(getConnection(ctx, id)?.preset ?? null),
  });
  catalog.onChange(() => catalogRegistry.invalidate());
  // A disabled (killed) connection's tools aren't listed; resolve still finds them, so a direct call gets the
  // policy's clear "turned off" answer. needs_reauth ones stay listed (calls say how to reconnect).
  const disabledIds = () => new Set(ctx.db.all<{ id: string }>("SELECT id FROM connections WHERE status = 'disabled'").map((r) => r.id));
  const visibleRegistry: ToolRegistry = {
    forAgent: (agentId) => {
      const off = disabledIds();
      const all = catalogRegistry.forAgent(agentId);
      return off.size ? all.filter((t) => !off.has(t.connectionId)) : all;
    },
    resolve: (agentId, name) => catalogRegistry.resolve(agentId, name),
    // The catalog registry's additive lookups (tool_on_hold) pass through.
    held: (agentId: string, name: string) => catalogRegistry.held(agentId, name),
  } as ToolRegistry;
  const base = { registry: visibleRegistry, connector: upstreamConnector(ctx, up, presetFor), ...given };
  const invalidate = (scope: InvalidateScope) => {
    if (given.invalidate) return given.invalidate(scope);
    if (typeof scope === "object" && "agentId" in scope) catalogRegistry.invalidateAgent(scope.agentId);
    else catalogRegistry.invalidate();
  };

  // The policy runtime (W6): BrokerCalls, get_call_status, approved calls, grant hooks and the kill switch.
  const policy = createBrokerPolicyRuntime(ctx, {
    registry: base.registry,
    sources: { source: (id) => service.source(id), close: (id) => closeSource(id) },
    credentials,
    refresher: up.refresher,
    onApprovalRequested: (ev) => {
      try {
        const { type, connectionId, ...detail } = ev;
        ctx.events.emit({ type, connectionId, dedupeKey: `${type}:${ev.approvalId}`, detail });
      } catch (err) {
        log.error("approval.requested event failed", { error: errorMessage(err) });
      }
    },
  });
  // A tool that left the upstream: its pending calls fail closed and its allow rules go.
  // The runtime registered for this context (brokerPolicyOf): this one, unless a test attached its own.
  const rt = (): BrokerPolicyRuntime => brokerPolicyOf(ctx) ?? policy;
  catalog.onToolRemoved((e) => void rt().onToolRemoved(e.connectionId, e.name));
  const parts: BrokerParts = {
    calls: { call: (agentId, name, args, signal) => rt().call(agentId, name, args, signal) },
    callStatus: (agentId, id) => rt().getCallStatus(agentId, id),
    runApprovedCall: (approval) => rt().runApprovedCall(approval),
    ...base,
  };

  const closeSource = async (connectionId: string) => {
    const s = sources.get(connectionId);
    sources.delete(connectionId);
    await s?.close().catch((err: unknown) => log.warn("Closing a tool source failed", { connection: connectionId, error: errorMessage(err) }));
    // The runtime pools remote sessions too: drop its entry, or the next source would be the closed one.
    await parts.connector.invalidate?.(connectionId).catch((err: unknown) => log.warn("Dropping an upstream session failed", { connection: connectionId, error: errorMessage(err) }));
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

  const defaultNativeDeps = (c: Connection): NativeSourceDeps => nativeDepsFor(ctx, up, c);

  /**
   * Catalog listing per connection. The catalog gets a proxy that resolves the live source on every listing, so a
   * reconnect (which replaces the pooled session) never leaves it on a closed one.
   */
  const attach = (connectionId: string) => {
    if (!enabled() || !service.source(connectionId)) return;
    const live = (): ToolSource => {
      const s = service.source(connectionId);
      if (!s) throw new SourceError("unavailable", "The connection is disabled or the broker is off");
      return s;
    };
    void catalog.attach({
      connectionId,
      listTools: (signal) => live().listTools(signal),
      callTool: (name, args, callCtx) => live().callTool(name, args, callCtx),
      close: async () => {},
    });
  };
  const attachAll = () => {
    for (const c of listConnections(ctx)) if (c.status !== "disabled") attach(c.id);
  };
  let wasOn = false;
  const onSettings = (s: { brokerUpstreams: boolean }) => {
    if (s.brokerUpstreams && !wasOn) attachAll();
    if (!s.brokerUpstreams && wasOn) {
      catalog.close();
      void closeAll();
    }
    wasOn = s.brokerUpstreams;
  };

  const presetOf = (c: Connection): IntegrationPreset | null => presetFor(c.preset);

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
    onGrantChanged: (agentId, connectionId) => void rt().onGrantChanged(agentId, connectionId),
    onGrantRemoved: (agentId, connectionId) => void rt().onGrantRemoved(agentId, connectionId),

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
      const c = getConnection(ctx, connectionId);
      if (!c || c.status === "disabled") return null;
      // Remote sources are pooled by the upstream runtime, which drops and rebuilds them on reconnect, URL or
      // allow edits: never cached here, so nothing keeps using a closed session.
      if (c.kind === "remote_http") return createSource(c);
      const existing = sources.get(connectionId);
      if (existing) return existing;
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
      // Disabled first, so nothing new starts; then the hooks, which may still need the credentials (a revoke).
      ctx.db.run("UPDATE connections SET status = 'disabled', status_reason = ?, updated_at = ? WHERE id = ?", reason, now(), connectionId);
      catalog.detach(connectionId);
      invalidate({ connectionId });
      for (const hook of parts.onKill ?? []) {
        try {
          await hook(connectionId);
        } catch (err) {
          log.warn("A kill switch hook failed", { connection: connectionId, error: errorMessage(err) });
        }
      }
      // The policy's kill: cancel pending calls, clear credentials, untrack refresh, close the source. Audited.
      await rt().killConnection(connectionId);
      ctx.db.run("UPDATE connections SET status_reason = ? WHERE id = ?", reason, connectionId);
      await closeSource(connectionId);
    },

    async remove(connectionId) {
      const c = getConnection(ctx, connectionId);
      if (!c) throw notFound("Connection");
      const agents = ctx.db.all<{ agent_id: string }>("SELECT agent_id FROM connection_grants WHERE connection_id = ?", connectionId);
      await this.kill(connectionId, "deleted");
      ctx.db.run("DELETE FROM connections WHERE id = ?", connectionId);
      invalidate("all");
      ctx.audit.record({ actorType: "admin", actorId: null, action: "connection.delete", target: connectionId, outcome: "ok", detail: { slug: c.slug } });
      for (const { agent_id } of agents) notifyAgent(ctx, agent_id);
    },

    acceptTool(connectionId, name, candidateHash) {
      try {
        if (parts.acceptTool) parts.acceptTool(connectionId, name, candidateHash);
        // The catalog re-classifies the candidate: the old risky/read class never carries over.
        else catalog.acceptHeldTool(connectionId, name, { candidateHash });
      } catch (err) {
        if (err instanceof CatalogError && err.code === "stale") throw conflict(err.message, "Reload the page to see the latest change.");
        if (err instanceof CatalogError && err.code === "not_held") throw new HttpError(404, "not_found", err.message);
        throw err;
      } finally {
        invalidate({ connectionId });
      }
    },

    invalidate,
    catalog,
    attach,

    emitConnectionEvent(e) {
      return ctx.events.emit({ type: e.type, connectionId: e.connectionId, dedupeKey: e.dedupeKey, detail: e.detail });
    },

    hooks,
    webhookUrl,
    pollEvents,

    start() {
      policy.start();
      ctx.bus.on("settings", onSettings);
      wasOn = enabled();
      if (wasOn) attachAll();
      pollTimer = setInterval(() => void pollEvents(), opts.pollTickMs ?? 60_000);
      pollTimer.unref();
    },

    async stop() {
      catalog.close();
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
  all_agents: number | null;
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
    allAgents: r.all_agents === 1,
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
