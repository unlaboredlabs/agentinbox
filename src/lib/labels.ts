import type {
  AccountStatus,
  ApprovalStatus,
  AuditOutcome,
  Capability,
  DeliveryStatus,
  EventType,
  SendMode,
} from "@shared/types";

export type Tone = "good" | "warn" | "bad" | "idle" | "info";

export const CAPABILITY_INFO: Record<Capability, { label: string; description: string }> = {
  read: {
    label: "Read",
    description: "Search and read messages, threads, labels and attachments, and receive mail events.",
  },
  draft: { label: "Draft", description: "Create, update and delete drafts. Nothing is sent." },
  send: {
    label: "Send",
    description: "Send, reply and forward. How sending behaves is set by the send mode below.",
  },
  organize: { label: "Organize", description: "Add and remove labels, archive, mark read or unread, star." },
  trash: { label: "Trash", description: "Move messages and threads to the trash (recoverable for 30 days in Gmail)." },
};

export const SEND_MODE_INFO: Record<SendMode, { label: string; short: string; description: string }> = {
  direct: {
    label: "Send directly",
    short: "Direct",
    description: "Messages go out immediately. Recipient allowlist and rate limits still apply.",
  },
  draft_only: {
    label: "Draft only",
    short: "Draft only",
    description: "Sending creates a Gmail draft instead. A human reviews and sends it from Gmail.",
  },
  approval: {
    label: "Needs approval",
    short: "Approval",
    description:
      "Sending creates a draft and queues it in Approvals here. Approving sends it; rejecting deletes the draft.",
  },
};

export const EVENT_TYPE_INFO: Record<EventType, { label: string; description: string }> = {
  "message.received": { label: "Message received", description: "A new message arrived (not sent by the account itself)." },
  "message.sent": { label: "Message sent", description: "A message was sent from the account, by an agent or a person." },
  "thread.reply_received": {
    label: "Reply received",
    description: "Someone replied in a thread the account has sent into. Great for follow-up agents.",
  },
  "label.added": { label: "Label added", description: "A label was added to a message." },
  "label.removed": { label: "Label removed", description: "A label was removed from a message." },
  "account.auth_failed": {
    label: "Account auth failed",
    description: "Google revoked or expired the account's access; it needs to be reconnected.",
  },
  "sync.gap": {
    label: "Sync gap",
    description: "History was too old to replay; a bounded resync ran and some events may be missing.",
  },
};

export const ACCOUNT_STATUS: Record<AccountStatus, { label: string; tone: Tone; description: string }> = {
  active: { label: "Active", tone: "good", description: "Syncing normally." },
  needs_reauth: {
    label: "Needs reconnect",
    tone: "bad",
    description: "Google no longer accepts this account's token. Reconnect it to resume.",
  },
  paused: { label: "Paused", tone: "idle", description: "Not syncing and not available to agents until resumed." },
  error: { label: "Error", tone: "bad", description: "Syncing failed. See the error for details." },
};

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  pending: { label: "Retrying", tone: "warn" },
  succeeded: { label: "Delivered", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  dead: { label: "Gave up", tone: "bad" },
};

export const APPROVAL_STATUS: Record<ApprovalStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  rejected: { label: "Rejected", tone: "idle" },
  sent: { label: "Sent", tone: "good" },
  failed: { label: "Send failed", tone: "bad" },
  expired: { label: "Expired", tone: "idle" },
};

export const AUDIT_OUTCOME: Record<AuditOutcome, { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "good" },
  denied: { label: "Denied", tone: "warn" },
  error: { label: "Error", tone: "bad" },
};

/** Plain-language explanations for guardrail denial reasons. */
export const DENIAL_REASONS: Record<string, string> = {
  allow_to: "A recipient isn't on the grant's allowlist",
  label_scope: "The message is outside the agent's label scope",
  rate_limit: "The grant's send cap was reached",
  capability: "The grant doesn't include this capability",
  reply_only: "The grant only allows replies in visible threads",
  no_grant: "The agent has no access to this account",
  disabled: "The agent is disabled",
  account_paused: "The account is paused",
  account_required: "The agent has several accounts and didn't say which one",
  needs_reauth: "The account needs to be reconnected",
  pairing_disabled: "Pairing is turned off in Settings",
  pending_cap: "Too many pairing requests are already waiting",
  lockout: "Too many wrong codes or keys from this address",
  not_found: "The item doesn't exist or is outside the agent's access",
};

export const KIND_LABEL = { send: "New message", reply: "Reply", forward: "Forward" } as const;
