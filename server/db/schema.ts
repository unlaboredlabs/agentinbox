// Ordered migrations. Append only — never edit a shipped migration.
// Conventions: ids are prefixed TEXT, timestamps are ISO-8601 TEXT (UTC), JSON is TEXT,
// booleans are INTEGER 0/1, secrets are AES-GCM ciphertext TEXT (see server/crypto.ts).

export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_error TEXT,
    refresh_token_enc TEXT NOT NULL,
    access_token_enc TEXT,
    access_expires_at TEXT,
    scopes TEXT NOT NULL DEFAULT '[]',
    history_id TEXT,
    watch_expires_at TEXT,
    last_sync_at TEXT,
    created_at TEXT NOT NULL
  );

  -- Pending OAuth flows (state → PKCE verifier). Short-lived.
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    reauth_account_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    disabled INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    capabilities TEXT NOT NULL,           -- JSON Capability[]
    label_scope TEXT,                     -- JSON string[] | NULL (= whole mailbox)
    send_mode TEXT NOT NULL DEFAULT 'draft_only',
    allow_to TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
    reply_only INTEGER NOT NULL DEFAULT 0,
    max_sends_per_hour INTEGER,
    max_sends_per_day INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (agent_id, account_id)
  );

  -- Agent event-feed cursor for the MCP pull tools (list_events / wait_for_events / ack_events).
  CREATE TABLE agent_cursors (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    account_id TEXT NOT NULL,
    gmail_message_id TEXT,
    gmail_thread_id TEXT,
    label_ids TEXT NOT NULL DEFAULT '[]',  -- JSON: message labels at event time (used for scope + filters)
    message TEXT,                          -- JSON MessageSummary | NULL
    changed_label_ids TEXT,                -- JSON string[] for label.added/removed
    detail TEXT,                           -- JSON
    dedupe_key TEXT NOT NULL UNIQUE,       -- e.g. "acc_x:msgid:message.received" — Pub/Sub is at-least-once
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_account_seq ON events(account_id, seq);
  CREATE INDEX events_thread ON events(account_id, gmail_thread_id);
  CREATE INDEX events_created ON events(created_at);

  -- Threads the account has sent into; drives thread.reply_received.
  CREATE TABLE sent_threads (
    account_id TEXT NOT NULL,
    gmail_thread_id TEXT NOT NULL,
    last_sent_at TEXT NOT NULL,
    PRIMARY KEY (account_id, gmail_thread_id)
  );

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    secret_prefix TEXT NOT NULL,
    event_types TEXT NOT NULL,   -- JSON EventType[]
    filter TEXT NOT NULL DEFAULT '{}', -- JSON WebhookFilter
    include_body INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_status_code INTEGER,
    last_error TEXT,
    last_response TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (webhook_id, event_seq)
  );
  CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
  CREATE INDEX deliveries_webhook ON deliveries(webhook_id, created_at);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    draft_id TEXT NOT NULL,
    payload TEXT NOT NULL,       -- JSON {to,cc,bcc,subject,body,threadId,attachments,reason}
    decided_at TEXT,
    decision_note TEXT,
    sent_message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX approvals_status ON approvals(status, created_at);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    account_id TEXT,
    target TEXT,
    outcome TEXT NOT NULL,
    reason TEXT,
    duration_ms INTEGER,
    detail TEXT
  );
  CREATE INDEX audit_ts ON audit_log(ts);
  CREATE INDEX audit_actor ON audit_log(actor_id, ts);
  `,

  /* 2: device-flow pairing + listener cursors */ `
  CREATE TABLE pairings (
    id TEXT PRIMARY KEY,
    device_code_hash TEXT NOT NULL UNIQUE, -- sha256 of the CLI's polling secret
    user_code TEXT NOT NULL,               -- shown in the terminal and the console, e.g. "K7QM-2XPD"
    name TEXT NOT NULL,
    description TEXT,
    requested TEXT NOT NULL DEFAULT '{}',  -- JSON
    client TEXT NOT NULL DEFAULT '{}',     -- JSON
    ip TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    api_key_enc TEXT,                      -- set on approval, wiped once delivered to the CLI
    last_poll_at TEXT,
    decided_at TEXT,
    decision_note TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX pairings_status ON pairings(status, created_at);
  CREATE INDEX pairings_user_code ON pairings(user_code);

  -- Server-side cursor per agentinbox-listen consumer (MCP ack_events keeps using agent_cursors).
  CREATE TABLE listener_cursors (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    consumer TEXT NOT NULL,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    client TEXT NOT NULL DEFAULT '{}',
    connected INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, consumer)
  );
  `,
  /* 3: onboarding diagnostics on accounts */ `
  -- When Google said the refresh token expires (refresh_token_expires_in); NULL = long-lived.
  ALTER TABLE accounts ADD COLUMN refresh_expires_at TEXT;
  -- Why it expires: 'testing' (initial lifetime ~7 days: External app in Testing) or 'time_based'
  -- (any other lifetime, e.g. time-based access the user chose on the consent screen). NULL = unknown.
  ALTER TABLE accounts ADD COLUMN refresh_expiry_kind TEXT;
  -- id_token "hd" claim: Workspace domain, '' = personal (non-Workspace) Google account, NULL = not known (connected before this migration).
  ALTER TABLE accounts ADD COLUMN workspace_domain TEXT;
  `,
];
