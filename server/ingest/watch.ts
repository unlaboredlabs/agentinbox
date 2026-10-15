import { GMAIL_WATCH_ERROR } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { allRows, getRow, updateRow } from "../google/accounts.ts";
import { errorMessage } from "../util/errors.ts";

/** Gmail watches expire after 7 days; renew once a day. */
export const WATCH_RENEW_AFTER_MS = 24 * 3600_000;
const WATCH_LIFETIME_MS = 7 * 24 * 3600_000;
const WATCH_ERROR = GMAIL_WATCH_ERROR;

export interface WatchResult {
  accountId: string;
  error?: unknown;
}

/** Starts (or renews) the whole-mailbox watch for one account and stores its expiry. */
export async function startWatch(ctx: AppContext, accountId: string, topic: string): Promise<void> {
  const res = await ctx.google.gmail(accountId).watch({ topicName: topic });
  const exp = Number(res.expiration);
  const expiresAt = new Date(Number.isFinite(exp) && exp > 0 ? exp : Date.now() + WATCH_LIFETIME_MS).toISOString();
  const staleError = getRow(ctx, accountId)?.last_error?.startsWith(WATCH_ERROR);
  updateRow(ctx, accountId, { watch_expires_at: expiresAt, ...(staleError ? { last_error: null } : {}) }, true);
}

/** Stops the watch (best effort) and clears its expiry. */
export async function stopWatch(ctx: AppContext, accountId: string): Promise<void> {
  const row = getRow(ctx, accountId);
  if (!row?.watch_expires_at) return;
  try {
    if (row.status !== "needs_reauth") await ctx.google.gmail(accountId).stopWatch();
  } catch (err) {
    ctx.log.child("ingest").warn("Could not stop the Gmail watch", { email: row.email, error: errorMessage(err) });
  }
  updateRow(ctx, accountId, { watch_expires_at: null }, true);
}

const needsRenewal = (expiresAt: string | null) =>
  !expiresAt || Date.parse(expiresAt) - Date.now() < WATCH_LIFETIME_MS - WATCH_RENEW_AFTER_MS;

/**
 * Starts or renews watches for every active account whose watch is missing or older than a day
 * (all of them with `force`). Per-account failures are recorded on the account and returned.
 */
export async function ensureWatches(
  ctx: AppContext,
  opts: { force?: boolean; topic?: string; signal?: AbortSignal } = {},
): Promise<WatchResult[]> {
  const topic = opts.topic ?? ctx.settings.getState("pubsub")?.topic;
  if (!topic) return [];
  const results: WatchResult[] = [];
  for (const row of allRows(ctx)) {
    if (opts.signal?.aborted) break;
    if (row.status !== "active" && row.status !== "error") continue;
    if (!opts.force && !needsRenewal(row.watch_expires_at)) continue;
    try {
      await startWatch(ctx, row.id, topic);
      results.push({ accountId: row.id });
    } catch (err) {
      ctx.log.child("ingest").warn("Could not start the Gmail watch", { email: row.email, error: errorMessage(err) });
      if (getRow(ctx, row.id)?.status === "active") {
        updateRow(ctx, row.id, { last_error: `${WATCH_ERROR}: ${errorMessage(err)}` }, true);
      }
      results.push({ accountId: row.id, error: err });
    }
  }
  return results;
}

/** Stops every watch (switching to poll mode). */
export async function stopAllWatches(ctx: AppContext): Promise<void> {
  for (const row of allRows(ctx)) if (row.watch_expires_at) await stopWatch(ctx, row.id);
}
