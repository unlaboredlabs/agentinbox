// Inbound webhooks for native presets: POST /hooks/connections/:id. Provider-facing, so it lives outside the admin
// session and CSRF guard (like CALENDAR_PUSH_PATH); the preset verifies the request itself (WHOOP: HMAC with the
// connection's client secret). Inert until the broker wiring supplies a ConnectionHookHost and brokerUpstreams is on.

import { Hono } from "hono";
import type { IntegrationEvent, IntegrationPreset, NativeSourceDeps } from "../broker/types.ts";
import type { SettingsStore } from "../settings.ts";
import type { Logger } from "../util/log.ts";

export const CONNECTION_HOOKS_PREFIX = "/hooks/connections";
/** WHOOP's payloads are four small fields. */
export const CONNECTION_HOOK_BODY_LIMIT = 16 * 1024;
/** Longer than any preset's signature tolerance (WHOOP: 2 h), so an accepted replay is still remembered. */
export const HOOK_DEDUPE_TTL_MS = 3 * 3_600_000;
const HOOK_DEDUPE_MAX = 2_000;

/** The inbound webhook URL for a connection, given the install's public URL. */
export const connectionHookUrl = (publicUrl: string, connectionId: string) =>
  `${publicUrl.replace(/\/+$/, "")}${CONNECTION_HOOKS_PREFIX}/${encodeURIComponent(connectionId)}`;

/** What the broker provides to the route (implemented where connections and the credential store live). */
export interface ConnectionHookHost {
  /**
   * The connection's preset, source deps, client secret and stored client record (CredentialStore.client: WHOOP keeps
   * the connected member's `whoop_user_id` there); null when the connection doesn't exist, is disabled or needs
   * re-auth, or has no client secret.
   */
  webhookTarget(connectionId: string): {
    preset: IntegrationPreset;
    deps: NativeSourceDeps;
    clientSecret: string;
    client: Record<string, unknown> | null;
  } | null;
  /** Into the events outbox (deduped on dedupeKey). Throwing makes the route answer 500, so the provider retries. */
  emit(events: IntegrationEvent[]): void;
}

/** The feature flag; read loosely until the Settings field lands with the console PR. */
export const brokerUpstreamsOn = (settings: Pick<SettingsStore, "get">): boolean =>
  (settings.get() as { brokerUpstreams?: unknown }).brokerUpstreams === true;

/** Recently emitted dedupe keys per connection (providers deliver an event more than once). */
class Seen {
  private readonly byConnection = new Map<string, Map<string, number>>();
  constructor(private readonly now: () => number) {}

  has(connectionId: string, key: string): boolean {
    const at = this.byConnection.get(connectionId)?.get(key);
    return at !== undefined && this.now() - at < HOOK_DEDUPE_TTL_MS;
  }

  mark(connectionId: string, key: string): void {
    let seen = this.byConnection.get(connectionId);
    if (!seen) this.byConnection.set(connectionId, (seen = new Map()));
    const t = this.now();
    seen.delete(key);
    seen.set(key, t);
    // Oldest first (insertion order): drop expired entries and anything over the cap.
    for (const [k, v] of seen) {
      if (seen.size <= HOOK_DEDUPE_MAX && t - v < HOOK_DEDUPE_TTL_MS) break;
      seen.delete(k);
    }
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function connectionHookRoutes(opts: { enabled: () => boolean; host: () => ConnectionHookHost | null; log: Logger; now?: () => number }) {
  const app = new Hono();
  const seen = new Seen(opts.now ?? Date.now);
  app.post(`${CONNECTION_HOOKS_PREFIX}/:id`, async (c) => {
    const id = c.req.param("id");
    const host = opts.enabled() ? opts.host() : null;
    const target = host && ID.test(id) ? host.webhookTarget(id) : null;
    const handle = target?.preset.events?.handleWebhook;
    if (!host || !target || !handle) return c.body(null, 404);
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    // The contract's deps plus the client record (additive; presets that don't need it ignore it).
    const deps: NativeSourceDeps & { clientSecret: string; client: Record<string, unknown> | null } = {
      ...target.deps,
      clientSecret: target.clientSecret,
      client: target.client,
    };
    let events: IntegrationEvent[] | null;
    try {
      events = await handle({ headers, rawBody }, deps);
    } catch (err) {
      opts.log.warn("connection webhook failed", { connectionId: id, error: (err as Error).message });
      return c.body(null, 500);
    }
    if (events === null) {
      opts.log.warn("connection webhook: bad signature", { connectionId: id });
      return c.body(null, 401);
    }
    const fresh = events.filter((e) => e.connectionId === id && !seen.has(id, e.dedupeKey));
    if (fresh.length) {
      try {
        host.emit(fresh);
      } catch (err) {
        // Not marked as seen: the provider's retry gets another chance.
        opts.log.warn("connection webhook: emit failed", { connectionId: id, error: (err as Error).message });
        return c.body(null, 500);
      }
      for (const e of fresh) seen.mark(id, e.dedupeKey);
    }
    return c.body(null, 204);
  });
  return app;
}
