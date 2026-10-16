// How quickly xaq notices mail someone else sends, for the console's speed claims.
// Relative (not @shared): unit tests type-check this file under the server config.
import { type Account, GMAIL_WATCH_ERROR, type IngestStatus, type PubsubState } from "../../shared/types.ts";

/** "30 seconds", "90 seconds", "2 minutes", "an hour": a poll interval in words. */
export function intervalInWords(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds === 3600) return "an hour";
  return `${Math.round(seconds / 60)} minutes`;
}

/**
 * - realtime: Pub/Sub is the ingest mode, provisioned, pulling without errors (and, for a given account,
 *   its Gmail watch is active): mail shows up within seconds.
 * - poll: polling was chosen.
 * - unfinished: Pub/Sub was chosen but isn't provisioned yet (ingest polls meanwhile).
 * - broken: Pub/Sub is provisioned but failing, or the account's Gmail watch failed or isn't active (ingest
 *   polls meanwhile). Other account errors (a failed sync) don't make push itself not work.
 * - inactive: the account asked about is paused, needs reconnecting or is gone: it isn't synced at all, so
 *   make no speed claim (neutral wording), and don't call real-time broken.
 * Outside realtime, mail shows up within the poll interval. Mail xaq sends itself (the setup test
 * email) shows up at once either way: it syncs right after sending.
 */
export type DeliveryMode = "realtime" | "poll" | "unfinished" | "broken" | "inactive";

/** The account's Gmail watch can't push: it failed (server/ingest/watch.ts), was never set up, or expired. */
const watchDown = (a: Pick<Account, "watchExpiresAt" | "lastError">, now: number) =>
  !!a.lastError?.startsWith(GMAIL_WATCH_ERROR) || !a.watchExpiresAt || Date.parse(a.watchExpiresAt) <= now;

export function deliveryMode(
  pubsub: Pick<PubsubState, "mode" | "subscription">,
  ingest: Pick<IngestStatus, "lastError">,
  account?: Pick<Account, "status" | "watchExpiresAt" | "lastError"> | null,
  now = Date.now(),
): DeliveryMode {
  if (account !== undefined && (!account || account.status !== "active")) return "inactive";
  if (pubsub.mode !== "pubsub") return "poll";
  if (!pubsub.subscription) return "unfinished";
  if (ingest.lastError) return "broken";
  if (account && watchDown(account, now)) return "broken";
  return "realtime";
}
