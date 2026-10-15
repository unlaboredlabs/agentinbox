// How quickly agentinbox notices mail someone else sends, for the console's speed claims.
// Relative (not @shared): unit tests type-check this file under the server config.
import type { Account, IngestStatus, PubsubState } from "../../shared/types.ts";

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
 * - broken: Pub/Sub is provisioned but failing, or the account's watch isn't active (ingest polls meanwhile).
 * Outside realtime, mail shows up within the poll interval. Mail agentinbox sends itself (the setup test
 * email) shows up at once either way: it syncs right after sending.
 */
export type DeliveryMode = "realtime" | "poll" | "unfinished" | "broken";

export function deliveryMode(
  pubsub: Pick<PubsubState, "mode" | "subscription">,
  ingest: Pick<IngestStatus, "lastError">,
  account?: Pick<Account, "status" | "watchExpiresAt" | "lastError"> | null,
  now = Date.now(),
): DeliveryMode {
  if (pubsub.mode !== "pubsub") return "poll";
  if (!pubsub.subscription) return "unfinished";
  if (ingest.lastError) return "broken";
  // null: an account was asked about but isn't there (removed): no real-time claim for it.
  if (account !== undefined && (!account || account.status !== "active" || account.lastError || !account.watchExpiresAt || Date.parse(account.watchExpiresAt) <= now)) return "broken";
  return "realtime";
}
