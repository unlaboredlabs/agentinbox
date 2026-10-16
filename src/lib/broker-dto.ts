// The console's view of the MCP broker's admin API (docs/MCP-BROKER.md). Defined here until the endpoint and
// policy branches land their DTOs in shared/types.ts; then these become re-exports. Relative imports only:
// vitest and the server typecheck load this module too.
//
// Routes the console calls (admin session + CSRF header, like every /api route):
//   GET    /api/connections                              → Connection[]
//   GET    /api/connections/presets                      → PresetView[]
//   POST   /api/connections/probe ProbeInput             → ProbeResult
//   POST   /api/connections CreateConnectionInput        → CreateConnectionResult
//   GET    /api/connections/:id                          → Connection
//   POST   /api/connections/:id/reconnect {header?}      → ReconnectResult   (OAuth: a new sign-in; header: replaces it)
//   POST   /api/connections/:id/disable                  → Connection
//   POST   /api/connections/:id/enable                   → Connection
//   DELETE /api/connections/:id                          → 204   (the kill switch: cancels pending calls, revokes, deletes credentials)
//   POST   /api/connections/oauth/status {state}         → ConnectionAttempt
//   POST   /api/connections/oauth/paste {url}            → Connection   (paste mode: the address the sign-in landed on)
//   GET    /api/connections/:id/held                     → HeldTool[]
//   POST   /api/connections/:id/tools/:name/accept       → 204   (re-pins the tool's live definition)
//   GET    /api/agents/:id/connections                   → AgentConnection[]
//   PUT    /api/agents/:id/connections/:connectionId {level: AgentLevel} → AgentConnection
//   GET    /api/approval-rules?agentId=                  → ApprovalRule[]
//   DELETE /api/approval-rules/:id                       → 204
//   GET    /api/approvals/:id                            → Approval (with `mcp` for kind "mcp.call")
//   POST   /api/approvals/:id/approve {note?, alwaysAllow?: {target: boolean}} → Approval
//   POST   /api/approvals/:id/reject {note?}             → Approval
// The connection OAuth callback page (/oauth/connections/callback) posts a ConnectionOAuthMessage to its opener and
// on BroadcastChannel "agentinbox-oauth".

import type { Approval, ApprovalStatus } from "../../shared/types.ts";

// Mirrors of the FROZEN contracts in server/broker/types.ts (the console's tsconfig has no Node types, which that
// file needs). test/console-broker.test.ts checks they stay assignable both ways.

/** One choice per connection (and per agent × connection). */
export type AccessLevel = "full" | "ask" | "read";

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** One step of a preset's guided setup. */
export interface SetupStep {
  id: string;
  title: string;
  body: string;
  link?: { label: string; url: string };
  copy?: { label: string; value: string };
  input?: { key: string; label: string; secret?: boolean; pattern?: string; placeholder?: string };
}

export type ConnectionStatus = "active" | "needs_reauth" | "error" | "disabled";
export type ConnectionKind = "native_google" | "native_whoop" | "remote_http" | "stdio";
export type ConnectionAuth = "none" | "header" | "oauth";

export interface Connection {
  id: string; // con_…
  /** Operator-chosen; tools are exposed as `<slug>__<tool>`. */
  slug: string;
  displayName: string;
  kind: ConnectionKind;
  presetId: string | null;
  url: string | null;
  auth: ConnectionAuth;
  status: ConnectionStatus;
  /** Why it needs a reconnect or failed, in plain words. */
  statusReason: string | null;
  /** When the credential stops working without a Reconnect (no refresh token, or a cap like Notion's 180 days). */
  reconnectBy: string | null;
  /** `scheme://host:port` the admin allowed on the private network, or null. */
  privateTarget: string | null;
  /** Pinned tools. */
  toolCount: number;
  /** Tools on hold because their definition changed (or they're new) since they were pinned. */
  heldCount: number;
  /** The level chosen when connecting (new agents get it when "all agents" was picked). */
  level: AccessLevel;
  createdAt: string;
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
  displayName?: string;
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
  connection: Connection;
  /** OAuth connections: the sign-in to run before it's active. */
  authorize: ConnectionAuthorize | null;
}

export interface ReconnectResult {
  connection: Connection;
  authorize: ConnectionAuthorize | null;
}

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

export interface HeldTool {
  /** The upstream's own name. */
  name: string;
  exposedName: string;
  /** changed: its definition differs from the pin; new: it wasn't there at connect. */
  change: "changed" | "new";
  /** The pinned definition (null for a new tool). */
  pinned: ToolDef | null;
  live: ToolDef;
  detectedAt: string;
}

/** An agent's level on one connection; "none" = no access (no grant row). */
export type AgentLevel = AccessLevel | "none";

export interface AgentConnection {
  connectionId: string;
  slug: string;
  displayName: string;
  status: ConnectionStatus;
  level: AgentLevel;
}

/** "Always allow this": calls matching agent + tool (+ target) skip the approval. */
export interface ApprovalRule {
  id: string;
  agentId: string;
  connectionId: string;
  connectionName: string;
  /** The upstream tool name. */
  tool: string;
  exposedName: string;
  targetPath: string | null;
  targetValue: string | null;
  createdAt: string;
}

/** The call an `mcp.call` approval runs. */
export interface McpCallDetail {
  connectionId: string;
  connectionName: string;
  slug: string;
  tool: string;
  exposedName: string;
  /** The exact stored argument bytes (canonical JSON): what runs on approve. */
  argsJson: string;
  argsSha256: string;
  /** The preset's target for "only for this target", when the call has one. */
  target: { path: string; value: string; label?: string } | null;
  /** The call's result once it ran (status "sent"), as text, for the done state. */
  resultPreview?: string | null;
}

/** An Approval as the API returns it once the broker adds `mcp.call` (Approval.kind is still the closed union). */
export type BrokerApproval = Omit<Approval, "kind"> & { kind: Approval["kind"] | "mcp.call"; mcp?: McpCallDetail };

export type { ApprovalStatus };
