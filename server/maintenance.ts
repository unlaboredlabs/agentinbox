import { adminAuth } from "./auth/index.ts";
import type { AppContext } from "./context.ts";
import { errorMessage } from "./util/errors.ts";

const INTERVAL_MS = 3600_000;
const FIRST_RUN_MS = 60_000;

export interface MaintenanceResult {
  events: number;
  deliveries: number;
  audit: number;
  sessions: number;
}

/** Prunes data older than Settings.retentionDays and expired admin sessions. Never throws. */
export function runMaintenance(ctx: AppContext): MaintenanceResult {
  const log = ctx.log.child("maintenance");
  const before = new Date(Date.now() - ctx.settings.get().retentionDays * 86_400_000).toISOString();
  const step = (name: string, fn: () => number) => {
    try {
      return fn();
    } catch (err) {
      log.warn(`Pruning ${name} failed`, { error: errorMessage(err) });
      return 0;
    }
  };
  // Deliveries first: they point at events.
  const result: MaintenanceResult = {
    deliveries: step("deliveries", () => ctx.webhooks.prune(before)),
    events: step("events", () => ctx.events.prune(before)),
    audit: step("audit log", () => ctx.audit.prune(before)),
    sessions: step("sessions", () => adminAuth(ctx).sessions.pruneExpired()),
  };
  if (Object.values(result).some((n) => n > 0)) log.info("Pruned old data", { ...result });
  return result;
}

/** Runs maintenance shortly after start, then hourly. Timers are unref'd. Returns a stop function. */
export function startMaintenance(ctx: AppContext): () => void {
  const run = () => {
    try {
      runMaintenance(ctx);
    } catch (err) {
      ctx.log.warn("Maintenance failed", { error: errorMessage(err) });
    }
  };
  const first = setTimeout(run, FIRST_RUN_MS).unref();
  const timer = setInterval(run, INTERVAL_MS).unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
