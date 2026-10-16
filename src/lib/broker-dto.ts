// The console's view of the MCP broker's admin API (docs/MCP-BROKER.md). Built on the shared DTOs (shared/types.ts);
// what's here is the part no merged branch defines yet (connections admin, presets, probe, agent access), so the
// endpoint writer can adopt or replace it. Relative imports only: vitest and the server typecheck load this module.
//
// Defined elsewhere (feat/broker-policy, merged here), used as is:
//   GET    /api/approvals/:id                            → McpCallApprovalView (mcp.call)
//   POST   /api/approvals/:id/approve McpCallApproveInput → Approval
//   POST   /api/approvals/:id/reject {note?}             → Approval
//   GET    /api/approval-rules?agentId&connectionId      → ApprovalRule[]
//   DELETE /api/approval-rules/:id                       → 204
//   POST   /api/connections/:id/kill                     → 204   (the kill switch: Remove)
//
// Assumed here, for the endpoint branch (admin session + CSRF header, like every /api route):
//   GET    /api/connections                              → ConnectionView[]
//   GET    /api/connections/presets                      → PresetView[]
//   POST   /api/connections/probe ProbeInput             → ProbeResult
//   POST   /api/connections CreateConnectionInput        → CreateConnectionResult
//   GET    /api/connections/:id                          → ConnectionView
//   POST   /api/connections/:id/reconnect {header?: {value}} → ReconnectResult   (OAuth: a new sign-in; header: replaces it)
//   POST   /api/connections/:id/disable                  → ConnectionView
//   POST   /api/connections/:id/enable                   → ConnectionView
//   POST   /api/connections/oauth/status {state}         → ConnectionAttempt
//   POST   /api/connections/oauth/paste {url}            → ConnectionView   (paste mode: the address the sign-in landed on)
//   GET    /api/connections/:id/tools                    → UpstreamTool[]
//   POST   /api/connections/:id/tools/:name/accept       → UpstreamTool   (re-pins a held tool's candidate)
//   GET    /api/agents/:id/connections                   → AgentConnection[]   (every connection, with this agent's level)
//   PUT    /api/agents/:id/connections/:connectionId {level: AgentLevel} → AgentConnection   ("none" deletes the grant)
// The connection OAuth callback page (/oauth/connections/callback) posts a ConnectionOAuthMessage to its opener and
// on BroadcastChannel "agentinbox-oauth".

import type { AccessLevel, Connection, ConnectionStatus } from "../../shared/types.ts";

/** One step of a preset's guided setup (mirrors SetupStep in server/broker/types.ts, which the console can't import). */
export interface SetupStep {
  id: string;
  title: string;
  body: string;
  link?: { label: string; url: string };
  copy?: { label: string; value: string };
  input?: { key: string; label: string; secret?: boolean; pattern?: string; placeholder?: string };
}

/** A connection as the Connections page lists it. */
export interface ConnectionView extends Connection {
  /** Pinned tools (active). */
  toolCount: number;
  /** Tools on hold because their definition changed (or they're new) since they were pinned. */
  heldCount: number;
}

/** A pre-made integration as the console shows it (IntegrationPreset without its functions). */
export interface PresetView {
  id: string;
  displayName: string;
  slug: string;
  kind: "remote_http" | "native";
  /** One line: what it gives agents. */
  description?: string;
  url?: string;
  auth: "none" | "header" | "mcp_oauth" | "user_app";
  /** Header presets: the header the key goes in. */
  headerName?: string;
  setupSteps: SetupStep[];
}

export interface ProbeInput {
  url: string;
  /** Set after the admin agreed to allow this private-network target (exactly the ProbeResult's `target`). */
  allowPrivate?: string;
}

/** What the broker found at a custom URL. Failures (unreachable, not MCP, bad URL) are ApiErrors with a hint. */
export type ProbeResult =
  | { kind: "open"; url: string; serverName: string | null; toolCount: number | null }
  | {
      kind: "oauth";
      url: string;
      /** The authorization server's issuer, e.g. https://auth.example.com. */
      issuer: string;
      /** How the broker will register: shipped/pasted client id, client ID metadata document, DCR, or it needs a client id. */
      registration: "preregistered" | "metadata_document" | "dcr" | "manual";
      serverName: string | null;
    }
  | { kind: "header"; url: string; headerName: string; prefix?: string; serverName: string | null }
  | {
      kind: "private";
      url: string;
      /** `scheme://host:port` to allow. */
      target: string;
      /** The address it resolved to. */
      address: string;
      range: "loopback" | "private" | "cgnat" | "ula";
    };

export interface CreateConnectionInput {
  presetId?: string;
  url?: string;
  slug: string;
  name?: string;
  level: AccessLevel;
  /** "all": every agent now and later (the default); otherwise these agents only. */
  agents: "all" | string[];
  header?: { name: string; value: string };
  privateTarget?: string;
  /** Values typed into the preset's setup steps, by SetupStep.input.key. */
  inputs?: Record<string, string>;
  /** OAuth servers without automatic registration: the client id the user registered. */
  clientId?: string;
}

/** An upstream sign-in to finish in a pop-up (direct) or by pasting the address it lands on (paste). */
export interface ConnectionAuthorize {
  authUrl: string;
  state: string;
  callbackMode: "direct" | "paste";
  redirectUri: string;
}

export interface CreateConnectionResult {
  connection: ConnectionView;
  /** OAuth connections: the sign-in to run before it's active. */
  authorize: ConnectionAuthorize | null;
}

export type ReconnectResult = CreateConnectionResult;

export type ConnectionAttempt =
  | { status: "pending" | "unknown" }
  | { status: "connected"; connectionId: string }
  | { status: "failed"; code: string; error: string; hint: string | null };

export interface ConnectionOAuthMessage {
  type: "agentinbox:connection-oauth";
  ok: boolean;
  connectionId: string | null;
  error: string | null;
  code: string | null;
  hint: string | null;
}

/** An agent's level on one connection; "none" = no access (no grant row). */
export type AgentLevel = AccessLevel | "none";

export interface AgentConnection {
  connectionId: string;
  slug: string;
  name: string;
  status: ConnectionStatus;
  level: AgentLevel;
}
