// How quickly agentinbox notices mail someone else sends, for the console's speed claims.

// Relative (not @shared): unit tests type-check this file under the server config.
import type { IngestStatus, PubsubState } from "../../shared/types.ts";

/** "30 seconds", "a minute", "5 minutes": a poll interval in words. */
export function intervalInWords(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

/**
 * Real-time only while Pub/Sub is the ingest mode, its subscription exists and the pull isn't failing
 * (ingest polls meanwhile: server/ingest/index.ts). Otherwise mail shows up within the poll interval.
 * Mail agentinbox sends itself (the setup test email) shows up at once either way: it syncs right after sending.
 */
export function isRealtime(pubsub: Pick<PubsubState, "mode" | "subscription"> | undefined, ingest: Pick<IngestStatus, "lastError"> | undefined): boolean {
  return pubsub?.mode === "pubsub" && !!pubsub.subscription && !ingest?.lastError;
}
