// Shared contract between the server (server/) and the web console (src/).
// Everything crossing the HTTP boundary of the console API (/api/*) is typed here.
// Timestamps are ISO-8601 strings in UTC. IDs are prefixed opaque strings (e.g. "agt_…").

/** The npm package (`npx agentinbox-cli`); the command it installs is `agentinbox`. */
export const NPM_PACKAGE = "agentinbox-cli";

// ───────────────────────────── Domain enums ─────────────────────────────

/** What an agent may do with a mailbox. `read` also grants search, labels, attachments and the event feed. */
export const CAPABILITIES = ["read", "draft", "send", "organize", "trash"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * How `send`/`reply`/`forward` behave for a grant.
 * - direct: sent immediately (still subject to allowlist + rate limits)
 * - draft_only: a Gmail draft is created instead; a human sends it from Gmail
 * - approval: a draft is created and an approval request is queued in the console;
 *   approving sends the draft, rejecting deletes it
 */
export const SEND_MODES = ["direct", "draft_only", "approval"] as const;
export type SendMode = (typeof SEND_MODES)[number];

/**
 * Whether an audit action is an MCP tool call: tool names never contain a "." (send_message), while
 * console and pairing actions do (agent.create, pairing.key_delivered). The SQL form of this rule is
 * mcpToolCallSql in server/audit.ts; keep the two in step.
 */
export const isMcpToolAction = (action: string): boolean => !action.includes(".");

export const EVENT_TYPES = [
  "message.received", // new message landed in the mailbox (not sent by the account; except the console's setup test email)
  "message.sent", // message sent from the account (by an agent or by a human)
  "thread.reply_received", // received message in a thread the account previously sent into
  "label.added",
  "label.removed",
  "account.auth_failed", // refresh token revoked/expired; account needs re-auth
  "sync.gap", // history was too old; a bounded resync ran and events may be missing
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type AccountStatus = "active" | "needs_reauth" | "paused" | "error";
export type IngestMode = "pubsub" | "poll";
export type DeliveryStatus = "pending" | "succeeded" | "failed" | "dead";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "sent" | "failed" | "expired";
export type AuditOutcome = "ok" | "denied" | "error";
export type ActorType = "agent" | "admin" | "system";

/** OAuth consent configuration the operator chose in Google Cloud. Drives setup guidance only. */
export type GoogleAppType = "internal" | "external";

// ───────────────────────────── Setup / system ─────────────────────────────

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  setupComplete: boolean;
}

/** GET /api/setup/status (unauthenticated). Drives the console's first route decision: claim, login or app. */
export interface SetupStatus {
  claimed: boolean;
  /** The request carries a valid admin session. */
  authenticated: boolean;
}

/** Live state of the ingest pipeline (Pub/Sub pull loop or history polling). */
export interface IngestStatus {
  mode: IngestMode;
  running: boolean;
  lastPullAt: string | null;
  lastError: string | null;
}

/** GET /api/system: facts about this instance for the settings page and connect snippets. */
export interface SystemInfo {
  version: string;
  nodeVersion: string;
  dataDir: string;
  /** Running under `agentinbox service install` (systemd/launchd). */
  service: boolean;
  /** URLs this machine is reachable at (localhost first, then LAN addresses). */
  addresses: string[];
  publicUrl: string;
  ingest: IngestStatus;
  /** Installs this instance as a service with the flags it runs with (`… service install --port 9000`), as the startup banner prints it. */
  serviceCommand: string;
}

/** GET /api/system/latest: update notice. */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Shell command that runs (or reinstalls the service with) the latest version using this instance's options. */
  command: string;
}

/** Ordered setup checklist; the console's setup wizard and overview both render this. */
export interface SetupState {
  /** True once an admin password exists. Before that, only /api/setup/claim with the setup token works. */
  claimed: boolean;
  googleClientConfigured: boolean;
  /** Google project id (needed for Pub/Sub). */
  gcpProjectId: string | null;
  googleAppType: GoogleAppType | null;
  pubsub: PubsubState;
  accountsConnected: number;
  agentsCreated: number;
  /** Some agent is known to work: its tool called /mcp (Agent.lastMcpAt), or a listener acked an event. */
  verified: boolean;
  /** All required steps done (claimed + client configured + ≥1 account). Pub/Sub is optional (poll fallback). */
  complete: boolean;
  /**
   * Problems with the setup as configured, most severe first (errors, then warnings, then info).
   * Recomputed on every GET /api/setup/state; empty when everything looks right. See SetupWarning.
   */
  warnings: SetupWarning[];
}

/**
 * - testing_mode: an account's refresh token was issued with a ~7-day lifetime (External app still in
 *   Testing). One per affected account (accountId set); `url` opens the project's Audience page.
 * - sign_in_expires: an account's refresh token expires for another reason (any other lifetime, e.g.
 *   time-based access the user chose on Google's consent screen). Neutral: reconnect before the date.
 *   One per account (accountId set). Both are "error" within 24 h of the expiry or after it.
 * - app_type_mismatch: the app type saved here contradicts the connected accounts. "warning" when it is
 *   "internal" but a personal (non-Workspace) Google account is connected (so the app is really External); "info" when it is
 *   "external" and every account is a Workspace account of one domain (Internal would avoid the 7-day
 *   Testing expiry and verification entirely).
 * - redirect_uri_missing: Google said the redirect URI isn't registered (GoogleClientCheck), or, when the
 *   check couldn't tell, the imported client JSON doesn't list it. Clears on a check or re-import that
 *   finds it, or once an account connects through the current redirect URI. Severity "error".
 * - redirect_uri_changed: the redirect URI changed (a public URL change) since the OAuth client was saved or
 *   imported, and nothing has shown the new one is registered yet. Names both URIs. Clears on a client check
 *   that finds it, a re-save/re-import of the client, or a connection through it. Severity "error".
 * - client_invalid: the last GoogleClientCheck found Google doesn't know the client ID. "error".
 * - client_secret_invalid: the last GoogleClientCheck found Google rejects the secret. "error".
 * - needs_reauth: an account's sign-in was rejected; one per account (accountId set). Severity "error".
 * - pubsub_failing: ingest mode is pubsub and Pub/Sub has an error (hint carries the remediation). "error".
 */
export type SetupWarningCode =
  | "testing_mode"
  | "sign_in_expires"
  | "client_invalid"
  | "client_secret_invalid"
  | "app_type_mismatch"
  | "redirect_uri_missing"
  | "redirect_uri_changed"
  | "needs_reauth"
  | "pubsub_failing";

export interface SetupWarning {
  code: SetupWarningCode;
  /** "error": something is broken or will break; "warning": will cause trouble later; "info": a suggestion. */
  severity: "error" | "warning" | "info";
  /** One sentence: what is wrong (names the account / date / URI when relevant). */
  message: string;
  /** What to do about it, with Google Cloud console click paths. */
  hint: string;
  /**
   * Deep link for the fix (a Google Cloud console page, project preselected), when there is one. The
   * hint always also names the menu path (e.g. "Google Auth Platform → Audience") in case the link
   * lands elsewhere: show both.
   */
  url?: string;
  /** Set for per-account warnings (testing_mode, sign_in_expires, needs_reauth, app_type_mismatch for a personal account). */
  accountId?: string;
}

export interface PubsubState {
  mode: IngestMode;
  topic: string | null; // projects/{p}/topics/{t}
  subscription: string | null; // projects/{p}/subscriptions/{s}
  /** Last provisioning/health error, human readable, with remediation hint. */
  lastError: string | null;
  /** Last time a Pub/Sub message was pulled (proves the pipeline works end-to-end). */
  lastMessageAt: string | null;
  /**
   * The connected account whose Google identity pulls the subscription ("Pub/Sub is set up with
   * <principalEmail>"): the one the last successful provisioning used. Before any provisioning (or if it
   * became inactive), the fallback: first active account with the Pub/Sub scope, else first active account.
   * null when no active account exists.
   */
  principalAccountId: string | null;
  principalEmail: string | null;
  /**
   * An account chosen with POST /api/google/pubsub/provision {accountId} whose provisioning hasn't
   * succeeded yet ("Switching to <pendingPrincipalEmail>…"). Provisioning and the incremental Pub/Sub
   * consent (POST /api/accounts/connect {scopes:["pubsub"]}) use it; it replaces the principal only once
   * provisioning (and its watch) succeed, so a failed switch never disturbs a working setup. null when none.
   */
  pendingPrincipalAccountId: string | null;
  pendingPrincipalEmail: string | null;
}

export interface Settings {
  /** Externally reachable base URL of this instance, e.g. https://mail.example.com. Used in MCP snippets + OAuth redirect. */
  publicUrl: string;
  ingestMode: IngestMode;
  pollIntervalSeconds: number;
  /** Max characters of message body returned to agents per message (0 = unlimited). */
  maxBodyChars: number;
  /** Days to keep events, deliveries and audit entries. */
  retentionDays: number;
  /** Approval requests auto-expire after this many hours. */
  approvalTtlHours: number;
  /**
   * SSRF guard: webhook targets that resolve to private, loopback or link-local addresses are refused
   * unless their host matches one of these entries (hostnames, IPs or CIDRs, e.g. "127.0.0.0/8",
   * "10.0.0.0/8", "n8n.internal"). Defaults to loopback only.
   */
  webhookAllowlist: string[];
  /** Accept device-flow pairing requests from `npx agentinbox-cli connect` (each still needs approval). */
  pairingEnabled: boolean;
}

export interface GoogleClientConfig {
  clientId: string;
  /** Write-only: never returned by the API. */
  clientSecret?: string;
  projectId: string;
  appType: GoogleAppType;
}

/**
 * POST /api/google/client/import: the client-secret JSON downloaded from Google Cloud
 * (Google Auth Platform → Clients → your client → Download JSON), pasted or read from the file as text.
 * Only Web application clients (`{"web": {...}}`) are accepted.
 */
export interface GoogleClientImportInput {
  /** The file's contents, verbatim. */
  json: string;
  /** Omit to keep the app type saved before (null when there was none). */
  appType?: GoogleAppType;
}

/**
 * POST /api/google/client/check (also run automatically by PUT /api/google/client and
 * POST /api/google/client/import): asks Google whether the saved client works, so problems show up
 * before connecting (Google reports them on its own page and never redirects back).
 * Undocumented Google behavior, classified conservatively: "unknown" means "couldn't tell", not "bad".
 * Each probe times out after 5 s. Results are kept for GET /api/setup/state warnings until the client is
 * saved again or an account connects (which proves everything).
 */
export interface GoogleClientCheck {
  /** "invalid": Google doesn't know this client ID (deleted, mistyped, other project). */
  clientId: "ok" | "invalid" | "unknown";
  /** "missing": GoogleClientView.redirectUri isn't an Authorized redirect URI of the client. */
  redirectUri: "ok" | "missing" | "unknown";
  /** "invalid": Google rejected the secret. "unknown" whenever clientId is "invalid". */
  secret: "ok" | "invalid" | "unknown";
  /** client_invalid | client_secret_invalid | redirect_uri_missing (all severity "error"). */
  warnings: SetupWarning[];
}

/** Returned by PUT /api/google/client: the saved client plus the automatic check. */
export interface GoogleClientSaveResult extends GoogleClientView {
  /** Same as `check.warnings` (for import also the JSON's redirect URI list when the check couldn't tell). */
  warnings: SetupWarning[];
  check: GoogleClientCheck;
}

/**
 * Result of POST /api/google/client/import. The client is saved whenever the ID and secret are present;
 * problems that don't prevent saving come back as `warnings` (client_invalid, client_secret_invalid,
 * redirect_uri_missing: all severity "error", connecting will fail until fixed).
 *
 * Errors (400, ApiError.code):
 * - client_json_invalid: not JSON, or not a Google OAuth client file, or a malformed client ID
 * - client_json_desktop: an "installed" (Desktop app) client; a Web application client is needed
 * - client_secret_missing: the file has no client_secret and none is stored for this client ID
 * - bad_request: invalid project_id (same validation as PUT /api/google/client)
 */
export interface GoogleClientImportResult extends GoogleClientSaveResult {
  /** The redirect URIs listed in the imported JSON (what Google had registered when it was downloaded). */
  registeredRedirectUris: string[];
}

/** Returned by GET /api/google/client. */
export interface GoogleClientView {
  clientId: string | null;
  hasSecret: boolean;
  projectId: string | null;
  appType: GoogleAppType | null;
  /** The exact redirect URI the operator must register on the OAuth client. */
  redirectUri: string;
  /**
   * "direct": Google redirects straight back to this console (localhost or https publicUrl).
   * "paste": publicUrl is plain-http non-localhost; Google can't redirect here, so the console
   * asks the user to paste the URL they land on after consent.
   */
  callbackMode: "direct" | "paste";
  /** Last 4 characters of the saved secret (to recognize which one is saved), or null without a secret. */
  secretHint: string | null;
  /**
   * There is evidence `redirectUri` is registered on the saved client: an account connected through it,
   * a client check found it, or the imported client JSON lists it. False without a client.
   */
  redirectUriConfirmed: boolean;
}

// ───────────────────────────── Accounts ─────────────────────────────

export interface Account {
  id: string; // acc_…
  email: string;
  displayName: string | null;
  status: AccountStatus;
  lastError: string | null;
  historyId: string | null;
  watchExpiresAt: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  /**
   * When Google said the refresh token expires (token response `refresh_token_expires_in`), or null for a
   * long-lived token. The account needs reconnecting before this time.
   */
  refreshTokenExpiresAt: string | null;
  /**
   * Why it expires (null when refreshTokenExpiresAt is null, or unknown): "testing" = issued with the ~7-day
   * Testing lifetime (External app not published; publish it, then reconnect); "time_based" = any other
   * lifetime (e.g. time-based access chosen on the consent screen).
   */
  refreshTokenExpiryKind: "testing" | "time_based" | null;
  /** Google Workspace domain (id_token `hd` claim), or null for a personal (non-Workspace) Google account (or not yet known). */
  workspaceDomain: string | null;
}

/** POST /api/accounts/:id/test-email: a self-addressed message sent through Gmail to prove delivery end to end. */
export interface TestEmailResult {
  /** Gmail message id of the sent message (matches MailEvent.message.id of the resulting events). */
  messageId: string;
  threadId: string;
  sentAt: string;
}

export interface GmailLabel {
  id: string; // Gmail label id, e.g. "INBOX" or "Label_123"
  name: string;
  type: "system" | "user";
}

/** POST /api/accounts/connect → start OAuth. */
export interface PubsubTestResult {
  ok: boolean;
  message: string;
}

/**
 * What the /oauth/callback page posts to its opener (window.postMessage) and on the
 * BroadcastChannel "agentinbox-oauth". On failure, `error`/`code`/`hint` mirror the ApiError that
 * POST /api/accounts/connect/complete returns for the same failure.
 */
export interface OAuthCallbackMessage {
  type: "agentinbox:oauth";
  ok: boolean;
  email: string | null;
  /** Human-readable message (null on success). */
  error: string | null;
  /** ApiError code, e.g. "oauth_access_denied" (null on success). See the route map for the list. */
  code: string | null;
  hint: string | null;
}

export interface ConnectAccountResponse {
  authUrl: string;
  /** Echoed state; in paste mode the console POSTs the pasted URL to /api/accounts/connect/complete. */
  state: string;
  callbackMode: "direct" | "paste";
}

// ───────────────────────────── Agents & grants ─────────────────────────────

/** How an agent was added: approved from `agentinbox connect` (its key lives in a profile on that machine), or created here with a copied key. */
export type AgentOrigin = "paired" | "key";

export interface Agent {
  id: string; // agt_…
  name: string;
  description: string | null;
  /** First chars of the key, for identification (e.g. "aib_7Hk2"). The full key is shown once at creation/rotation. */
  keyPrefix: string;
  disabled: boolean;
  origin: AgentOrigin;
  /** Last request with this agent's key (MCP or the listener API), written at most once a minute. */
  lastUsedAt: string | null;
  /** Last request to /mcp only (a tool's startup `tools/list` counts), written at most once a minute. */
  lastMcpAt: string | null;
  createdAt: string;
  grants: Grant[];
  /** `agentinbox listen` instances (one per consumer name) and their stream position. */
  listeners: ListenerInfo[];
}

export interface ListenerInfo {
  consumer: string;
  connected: boolean;
  /**
   * Where the cursor started when the consumer was created (the head, or 0 for start=beginning):
   * events at or below it predate the listener and weren't delivered to it. Null = unknown (created
   * before this was recorded, or by an ack).
   */
  startSeq: number | null;
  ackedSeq: number;
  /**
   * Event types the listener's stream asked for when it last connected (every type when it named
   * none). Events of other types are acknowledged without running its command. Null = unknown
   * (recorded before this existed).
   */
  types: EventType[] | null;
  lastSeenAt: string | null;
  client: { hostname?: string; platform?: string; version?: string };
}

export type PairingStatus = "pending" | "approved" | "denied" | "expired";

/** A device-flow pairing request from `npx agentinbox-cli connect`, shown in the approvals inbox. */
export interface PairingRequest {
  id: string; // par_…
  /** The code the agent's terminal shows; the human must match it before approving. */
  userCode: string;
  name: string;
  description: string | null;
  requested: { accounts?: string[]; capabilities?: Capability[]; sendMode?: SendMode; reason?: string };
  client: { hostname?: string; platform?: string; tool?: string; version?: string };
  /** Requester IP as seen by the daemon. */
  ip: string | null;
  status: PairingStatus;
  /** Set once approved. */
  agentId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

/** POST /api/pairings/:id/approve. Grants default to sendMode draft_only in the console. */
export interface ApprovePairingInput {
  /** Typed by the human from the agent's terminal (not pre-filled); case and dashes are ignored. 409 on mismatch. */
  userCode: string;
  name?: string;
  grants: (GrantInput & { accountId: string })[];
}

export interface Grant {
  id: string; // grt_…
  agentId: string;
  accountId: string;
  capabilities: Capability[];
  /** Gmail label ids the agent is confined to (thread-level: a thread is visible if any message carries one). null = whole mailbox. */
  labelScope: string[] | null;
  sendMode: SendMode;
  /** Recipient allowlist: exact addresses or "*@domain.com" globs. Empty = any recipient. */
  allowTo: string[];
  /** Only allow sending replies inside threads the agent can already see. */
  replyOnly: boolean;
  maxSendsPerHour: number | null;
  maxSendsPerDay: number | null;
  createdAt: string;
}

export type GrantInput = Omit<Grant, "id" | "agentId" | "createdAt">;

export interface CreateAgentInput {
  name: string;
  description?: string | null;
  grants?: GrantInput[];
}

/** POST /api/agents/:id/test: runs MCP initialize + tools/list as the agent, in-process. */
export interface AgentTestResult {
  ok: boolean;
  tools: string[];
  message: string;
}

/** Returned once on create and on key rotation. */
export interface AgentWithKey {
  agent: Agent;
  apiKey: string; // aib_…
}

// ───────────────────────────── Events ─────────────────────────────

export interface Address {
  name: string | null;
  email: string;
}

/** Normalized message metadata carried in events. No bodies are stored server-side. */
export interface MessageSummary {
  id: string; // Gmail message id
  threadId: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string;
  snippet: string;
  date: string; // ISO
  labelIds: string[];
  hasAttachments: boolean;
}

export interface MailEvent {
  id: string; // evt_…
  seq: number; // monotonic, used as cursor
  type: EventType;
  accountId: string;
  accountEmail: string;
  message: MessageSummary | null;
  /** For label.added / label.removed. */
  labelIds?: string[];
  /** Free-form detail for account/sync events. */
  detail?: Record<string, unknown>;
  createdAt: string;
  /**
   * Console only (GET /api/events and the console stream): the thread's labels when the event was
   * recorded, which agents' label scopes are matched against. Never sent to agents or webhooks.
   */
  threadLabelIds?: string[];
}

// ───────────────────────────── Webhooks ─────────────────────────────

export interface WebhookFilter {
  accountIds?: string[];
  /** Match if the message has any of these label ids. */
  labelIds?: string[];
  /** Glob on sender address, e.g. "*@stripe.com". Any match passes. */
  from?: string[];
  /** Glob on any to/cc address. */
  to?: string[];
  /** Case-insensitive regular expression tested against the subject. */
  subject?: string;
  hasAttachments?: boolean;
}

export interface Webhook {
  id: string; // whk_…
  agentId: string;
  name: string;
  url: string;
  eventTypes: EventType[];
  filter: WebhookFilter;
  /** Include the cleaned message body (markdown) in the payload. */
  includeBody: boolean;
  enabled: boolean;
  /** Shown once at creation and on rotation ("whsec_…", Standard Webhooks format). */
  secretPrefix: string;
  createdAt: string;
  stats: { succeeded24h: number; failed24h: number; lastDeliveryAt: string | null };
}

export type WebhookInput = Omit<Webhook, "id" | "secretPrefix" | "createdAt" | "stats">;

export interface WebhookWithSecret {
  webhook: Webhook;
  secret: string;
}

export interface Delivery {
  id: string; // dlv_…
  webhookId: string;
  eventId: string;
  eventType: EventType;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  /** First ~500 chars of the receiver's response body. */
  lastResponse: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Webhook HTTP request body. Signed per https://www.standardwebhooks.com:
 * headers webhook-id, webhook-timestamp, webhook-signature ("v1,<base64 hmac-sha256>").
 */
export interface WebhookPayload {
  type: EventType;
  timestamp: string;
  data: MailEvent & {
    /** Present only when the webhook has includeBody and the event concerns a message. */
    content?: MessageContent;
    /** Set instead of `content` when includeBody was requested but the body could not be fetched. */
    contentError?: string;
  };
}

// ───────────────────────────── Message content (returned to agents) ─────────────────────────────

/** Signals attached to content. Informational: the content itself is still delivered (cleaned, not censored). */
export interface ContentSignals {
  /** Invisible content (display:none, zero-size/transparent text, HTML comments, zero-width/tag unicode) was removed. */
  hiddenContentRemoved: boolean;
  /** Phrases that commonly appear in prompt-injection attempts ("ignore previous instructions", …). */
  suspiciousInstructions: string[];
  /** SPF/DKIM/DMARC results parsed from Authentication-Results. null when the header is absent. */
  auth: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  /** Sender is outside the account's own domain. */
  external: boolean;
}

export interface Attachment {
  id: string; // Gmail attachment id
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageContent {
  /** Body converted to markdown (from HTML) or the plain-text part. */
  body: string;
  truncated: boolean;
  attachments: Attachment[];
  signals: ContentSignals;
}

// ───────────────────────────── Approvals ─────────────────────────────

export interface Approval {
  id: string; // apr_…
  agentId: string;
  agentName: string;
  accountId: string;
  accountEmail: string;
  kind: "send" | "reply" | "forward";
  status: ApprovalStatus;
  draftId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** Full body as the agent wrote it (markdown/plain). */
  body: string;
  threadId: string | null;
  attachments: { filename: string; size: number }[];
  /** Why the agent says it is sending (optional `reason` tool arg). */
  reason: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  sentMessageId: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

// ───────────────────────────── Audit ─────────────────────────────

export interface AuditEntry {
  id: number;
  ts: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  action: string; // MCP tool name or console action, e.g. "send_message", "agent.create"
  accountId: string | null;
  target: string | null; // message/thread/draft id
  outcome: AuditOutcome;
  /** For denials: the guardrail that blocked it, e.g. "allow_to", "label_scope", "rate_limit". */
  reason: string | null;
  durationMs: number | null;
  detail: Record<string, unknown> | null;
}

// ───────────────────────────── Overview ─────────────────────────────

export interface OverviewStats {
  accounts: { total: number; active: number; needsAttention: number };
  agents: { total: number; activeLast24h: number };
  events24h: number;
  deliveries24h: { succeeded: number; failed: number };
  pendingApprovals: number;
  toolCalls24h: number;
  denied24h: number;
  /** Hourly buckets for the last 24h, oldest first. */
  activity: { hour: string; events: number; toolCalls: number }[];
}

// ───────────────────────────── Pagination & errors ─────────────────────────────

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; null when exhausted. */
  nextCursor: string | null;
}

/** All non-2xx console API responses have this body. */
export interface ApiError {
  /** `email`: only on oauth_already_connected (from the authenticated paste endpoint), the account that sign-in connected. */
  error: { code: string; message: string; hint?: string; email?: string };
}

// ───────────────────────────── Console API route map ─────────────────────────────
// Session: cookie `aib_session` (HttpOnly, SameSite=Lax). Mutating requests must send header
// `x-agentinbox-csrf: 1` (simple CSRF guard; the console fetch wrapper always sets it).
//
// Unauthenticated:
//   GET    /api/health                                → HealthResponse
//   GET    /api/setup/status                          → SetupStatus
//   POST   /api/setup/claim {token,password}          → 204 + session cookie (only while unclaimed)
//   POST   /api/setup/verify-token {token}            → 204 when the setup token is right (same limiter as claim)
//   POST   /api/auth/login {password}                 → 204 + session cookie (5 failures/IP → 15 min lockout)
//   POST   /api/auth/logout                           → 204
//   GET    /oauth/callback?code&state                 → HTML result page; posts an OAuthCallbackMessage (ok/email or error/code/hint)
//                                                       to its opener and on BroadcastChannel "agentinbox-oauth"
//
// Authenticated (admin session):
//   GET    /api/setup/state                           → SetupState
//   GET    /api/system                                → SystemInfo
//   GET    /api/system/latest                         → UpdateInfo   (npm registry check, cached 30 min)
//   GET    /api/settings                              → Settings
//   PATCH  /api/settings Partial<Settings>            → Settings
//   POST   /api/auth/password {current,next}          → 204
//   GET    /api/google/client                         → GoogleClientView
//   PUT    /api/google/client GoogleClientConfig      → GoogleClientSaveResult   (manual entry; fallback to import; runs the check)
//   POST   /api/google/client/check                   → GoogleClientCheck   (400 google_client_missing when nothing is saved)
//   POST   /api/google/client/import GoogleClientImportInput → GoogleClientImportResult   (runs the check)
//          400 client_json_invalid | client_json_desktop | client_secret_missing | bad_request (see GoogleClientImportResult)
//   POST   /api/google/pubsub/provision {accountId?}  → PubsubState   (creates topic + IAM + subscription using the principal account's token;
//          `accountId` chooses the principal: saved as pending (PubsubState.pendingPrincipal*), so the follow-up
//          POST /api/accounts/connect {scopes:["pubsub"]} targets it; it becomes the principal only when provisioning succeeds)
//          409 pubsub_scope_required (the principal hasn't granted the Pub/Sub scope: run that incremental consent, retry)
//          409 needs_reauth | 409 account_paused (chosen account unusable) | 404 not_found (unknown accountId)
//          400 pubsub_permission_denied (principal lacks roles/pubsub.admin or Owner; hint: IAM link + gcloud command)
//              | pubsub_billing | pubsub_org_policy (Domain Restricted Sharing; hint: org policy link, polling alternative)
//              | pubsub_api_disabled | gmail_api_disabled | pubsub_publish_denied | pubsub_project_not_found
//              | pubsub_project_missing | pubsub_no_account | pubsub_provision_failed (anything else)
//   POST   /api/google/pubsub/test                    → PubsubTestResult
//   GET    /api/accounts                              → Account[]
//   POST   /api/accounts/connect                      → ConnectAccountResponse
//          400 google_client_missing (no OAuth client saved yet)
//   POST   /api/accounts/connect/complete {url}       → Account   (paste mode)
//          Connect failures (same codes on this endpoint and in the callback page's OAuthCallbackMessage):
//          400 oauth_access_denied (cancelled on Google's screen) | oauth_org_internal | oauth_admin_policy_enforced
//              | oauth_redirect_uri_mismatch | oauth_invalid_client | oauth_unauthorized_client | oauth_invalid_grant
//              | oauth_<other Google error> | oauth_state (expired/used link) | oauth_no_code | oauth_url_invalid
//              | oauth_gmail_scope_missing | oauth_no_refresh_token | oauth_wrong_account | oauth_account_removed
//              | gmail_api_disabled | google_client_missing;  502 google_error
//   POST   /api/accounts/:id/resync                   → Account
//   POST   /api/accounts/:id/pause | /resume          → Account
//   DELETE /api/accounts/:id                          → 204 (stops watch, revokes token, deletes grants)
//   GET    /api/accounts/:id/labels                   → GmailLabel[]
//   POST   /api/accounts/:id/test-email               → TestEmailResult   (sends "agentinbox test: your setup works" from the
//          account to itself, then processes new mail at once; the resulting events are message.sent and message.received
//          (the latter only for this test message). Audited as account.test_email. 409 account_paused | 409 needs_reauth
//          | 429 rate_limited (5 per account per 10 min; hint says when to retry))
//   GET    /api/agents                                → Agent[]
//   POST   /api/agents CreateAgentInput               → AgentWithKey
//   GET    /api/agents/:id                            → Agent
//   PATCH  /api/agents/:id {name?,description?,disabled?} → Agent
//   POST   /api/agents/:id/rotate-key                 → AgentWithKey
//   DELETE /api/agents/:id                            → 204
//   PUT    /api/agents/:id/grants/:accountId GrantInput → Grant   (upsert; one grant per agent×account)
//   DELETE /api/agents/:id/grants/:accountId          → 204
//   POST   /api/agents/:id/test                       → AgentTestResult (runs MCP initialize+tools/list as the agent)
//   GET    /api/webhooks?agentId                      → Webhook[]
//   POST   /api/webhooks WebhookInput                 → WebhookWithSecret
//   PATCH  /api/webhooks/:id Partial<WebhookInput>    → Webhook
//   POST   /api/webhooks/:id/rotate-secret            → WebhookWithSecret
//   POST   /api/webhooks/:id/test                     → Delivery  (sends a synthetic event synchronously)
//   DELETE /api/webhooks/:id                          → 204
//   GET    /api/deliveries?webhookId&status&cursor    → Page<Delivery>
//   POST   /api/deliveries/:id/replay                 → Delivery
//   GET    /api/events?accountId&type&cursor          → Page<MailEvent>
//   GET    /api/events/stream                         → text/event-stream of ConsoleStreamMessage (SSE `data:` = JSON)
//   GET    /api/pairings?status                       → PairingRequest[]
//   POST   /api/pairings/:id/approve ApprovePairingInput → Agent   (the key goes to the polling CLI, never to the console)
//   POST   /api/pairings/:id/deny {note?}             → PairingRequest
//   GET    /api/approvals?status                      → Approval[]
//   POST   /api/approvals/:id/approve {note?}         → Approval
//   POST   /api/approvals/:id/reject {note?}          → Approval
//   GET    /api/audit?agentId&outcome&cursor          → Page<AuditEntry>
//   GET    /api/overview                              → OverviewStats
//
// Agent-facing (bearer = agent API key):
//   POST/GET/DELETE /mcp                               MCP streamable HTTP (stateless)
//   GET    /skill.md                                   the agent skill (public, no secrets)
//   /agent/v1/*                                        pairing + listener stream (see shared/agent-api.ts)
//   GET    /health                                     HealthResponse (alias of /api/health for uptime monitors; 503 when degraded)

export type ConsoleStreamMessage =
  | { kind: "event"; data: MailEvent }
  | { kind: "delivery"; data: Delivery }
  | { kind: "approval"; data: Approval }
  | { kind: "audit"; data: AuditEntry }
  | { kind: "account"; data: Account }
  | { kind: "pairing"; data: PairingRequest }
  /** An agent's state changed: listener connect/disconnect/ack (at most ~1/s), first use and lastMcpAt, access changes. */
  | { kind: "agent"; data: Agent };
