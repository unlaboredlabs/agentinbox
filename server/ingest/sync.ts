import type { EventType } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { type AccountRow, updateRow } from "../google/accounts.ts";
import { type GmailClient, GoogleApiError, type GmailHistoryRecord, type GmailMessage } from "../google/types.ts";

export const HISTORY_TYPES = ["messageAdded", "labelAdded", "labelRemoved"];
const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date"];
/** New messages with these labels produce no events. */
const SKIP_NEW = ["DRAFT", "SPAM", "CHAT"];
/** Label churn that isn't interesting as label.added/removed (drafts being saved, SENT handled as message.sent). */
const SKIP_LABEL_CHANGES = new Set(["DRAFT", "SENT"]);
/** Bounded resync window after a history gap. */
const RESYNC_QUERY = "newer_than:2d";
const RESYNC_MAX = 100;

const isNotFound = (err: unknown) => err instanceof GoogleApiError && err.status === 404;

/**
 * One sync pass over an account: turns Gmail history records (or a list of recent messages) into
 * events. Thread label unions are cached for the pass.
 */
export class SyncPass {
  emitted = 0;
  private readonly gmail: GmailClient;
  private readonly threadLabels = new Map<string, Promise<string[]>>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly account: AccountRow,
  ) {
    this.gmail = ctx.google.gmail(account.id);
  }

  async process(records: GmailHistoryRecord[]): Promise<void> {
    const added = new Set<string>();
    for (const r of records) for (const m of r.messagesAdded ?? []) added.add(m.message.id);
    for (const r of records) {
      for (const { message } of r.messagesAdded ?? []) {
        if (message.labelIds?.some((l) => SKIP_NEW.includes(l))) continue;
        const meta = await this.fetch(message.id);
        if (meta) await this.newMessage(meta);
      }
      for (const [type, changes] of [
        ["label.added", r.labelsAdded],
        ["label.removed", r.labelsRemoved],
      ] as const) {
        for (const { message, labelIds } of changes ?? []) {
          if (added.has(message.id)) continue;
          // A message that gains SENT outside a messagesAdded record (e.g. a sent draft) is still a send.
          if (type === "label.added" && labelIds.includes("SENT")) {
            const meta = await this.fetch(message.id);
            if (meta) await this.newMessage(meta);
          }
          const changed = labelIds.filter((l) => !SKIP_LABEL_CHANGES.has(l));
          if (!changed.length || message.labelIds?.includes("DRAFT")) continue;
          const meta = await this.fetch(message.id);
          if (!meta || meta.labelIds?.includes("DRAFT")) continue;
          this.emit(type, meta, await this.threadLabelIds(meta), `${message.id}:${type}:${r.id}`, changed);
        }
      }
    }
  }

  /** Emits message.sent / message.received (+ thread.reply_received) for a metadata-format message. */
  async newMessage(msg: GmailMessage): Promise<void> {
    const labels = msg.labelIds ?? [];
    if (labels.some((l) => SKIP_NEW.includes(l))) return;
    const threadLabels = await this.threadLabelIds(msg);
    if (labels.includes("SENT")) {
      this.ctx.db.run(
        `INSERT INTO sent_threads (account_id, gmail_thread_id, last_sent_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
        this.account.id,
        msg.threadId,
        now(),
      );
      this.emit("message.sent", msg, threadLabels, `${msg.id}:message.sent`);
      return;
    }
    this.emit("message.received", msg, threadLabels, `${msg.id}:message.received`);
    const sentInto =
      threadLabels.includes("SENT") ||
      this.ctx.db.get("SELECT 1 AS x FROM sent_threads WHERE account_id = ? AND gmail_thread_id = ?", this.account.id, msg.threadId);
    if (sentInto) this.emit("thread.reply_received", msg, threadLabels, `${msg.id}:thread.reply_received`);
  }

  /** format=metadata; null when the message was deleted meanwhile. */
  async fetch(id: string): Promise<GmailMessage | null> {
    try {
      return await this.gmail.getMessage(id, "metadata", METADATA_HEADERS);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Union of labels across the message's thread (label scopes are thread-level). */
  threadLabelIds(msg: GmailMessage): Promise<string[]> {
    let p = this.threadLabels.get(msg.threadId);
    if (!p) {
      p = this.gmail.getThread(msg.threadId, "minimal").then(
        (t) => [...new Set([...(msg.labelIds ?? []), ...(t.messages ?? []).flatMap((m) => m.labelIds ?? [])])],
        (err: unknown) => {
          if (isNotFound(err)) return msg.labelIds ?? [];
          throw err;
        },
      );
      this.threadLabels.set(msg.threadId, p);
    }
    return p.then((labels) => [...new Set([...labels, ...(msg.labelIds ?? [])])]);
  }

  private emit(type: EventType, msg: GmailMessage, threadLabelIds: string[], key: string, labelIds?: string[]): void {
    const dedupeKey = `${this.account.id}:${key}`;
    if (this.seen.has(dedupeKey)) return;
    this.seen.add(dedupeKey);
    const ev = this.ctx.events.emit({
      type,
      accountId: this.account.id,
      message: this.ctx.google.mime.summarize(msg),
      threadLabelIds,
      ...(labelIds ? { labelIds } : {}),
      dedupeKey,
    });
    if (ev) this.emitted++;
  }
}

/** Reads all history after the account's cursor. Throws GoogleApiError 404 when the cursor is too old. */
export async function readHistory(gmail: GmailClient, startHistoryId: string): Promise<{ records: GmailHistoryRecord[]; historyId: string }> {
  const records: GmailHistoryRecord[] = [];
  let pageToken: string | undefined;
  let historyId = startHistoryId;
  do {
    const page = await gmail.listHistory({ startHistoryId, pageToken, maxResults: 500, historyTypes: HISTORY_TYPES });
    records.push(...page.history);
    historyId = page.historyId || historyId;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return { records, historyId };
}

/**
 * Bounded resync: emits events for recent messages (dedupe drops the ones already seen), resets the
 * cursor to the mailbox's current historyId and emits sync.gap.
 */
export async function boundedResync(ctx: AppContext, account: AccountRow, reason: "history_expired" | "manual"): Promise<number> {
  const gmail = ctx.google.gmail(account.id);
  // Profile first: anything that arrives during the listing is picked up by the next history sync.
  const profile = await gmail.getProfile();
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail.listMessages({ q: RESYNC_QUERY, maxResults: RESYNC_MAX - ids.length, pageToken });
    ids.push(...page.messages.map((m) => m.id));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && ids.length < RESYNC_MAX);
  const pass = new SyncPass(ctx, account);
  for (const id of ids.reverse()) {
    const meta = await pass.fetch(id);
    if (meta) await pass.newMessage(meta);
  }
  ctx.events.emit({
    type: "sync.gap",
    accountId: account.id,
    detail: {
      reason,
      since: account.last_sync_at,
      previousHistoryId: account.history_id,
      resyncedMessages: ids.length,
      window: RESYNC_QUERY,
    },
    // A manual resync always reports; an expired cursor reports once per incident.
    dedupeKey: `${account.id}:sync.gap:${reason}:${reason === "manual" ? Date.now() : `${account.history_id ?? ""}:${profile.historyId}`}`,
  });
  updateRow(ctx, account.id, { history_id: String(profile.historyId), last_sync_at: now() }, true);
  ctx.log.child("ingest").info("Resynced recent messages", { email: account.email, reason, messages: ids.length, events: pass.emitted });
  return pass.emitted;
}
