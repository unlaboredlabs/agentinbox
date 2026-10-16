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

/** The inbound webhook URL for a connection, given the install's public URL. */
export const connectionHookUrl = (publicUrl: string, connectionId: string) =>
  `${publicUrl.replace(/\/+$/, "")}${CONNECTION_HOOKS_PREFIX}/${encodeURIComponent(connectionId)}`;

/** What the broker provides to the route (implemented where connections and the credential store live). */
export interface ConnectionHookHost {
  /**
   * The connection's preset, source deps and client secret; null when the connection doesn't exist, is disabled or
   * needs re-auth, or has no client secret.
   */
  webhookTarget(connectionId: string): { preset: IntegrationPreset; deps: NativeSourceDeps; clientSecret: string } | null;
  /** Into the events outbox (deduped on dedupeKey). */
  emit(events: IntegrationEvent[]): void;
}

/** The feature flag; read loosely until the Settings field lands with the console PR. */
export const brokerUpstreamsOn = (settings: Pick<SettingsStore, "get">): boolean =>
  (settings.get() as { brokerUpstreams?: unknown }).brokerUpstreams === true;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function connectionHookRoutes(opts: { enabled: () => boolean; host: () => ConnectionHookHost | null; log: Logger }) {
  const app = new Hono();
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
    let events: IntegrationEvent[] | null;
    try {
      events = await handle({ headers, rawBody }, { ...target.deps, clientSecret: target.clientSecret });
    } catch (err) {
      opts.log.warn("connection webhook failed", { connectionId: id, error: (err as Error).message });
      return c.body(null, 500);
    }
    if (events === null) {
      opts.log.warn("connection webhook: bad signature", { connectionId: id });
      return c.body(null, 401);
    }
    const own = events.filter((e) => e.connectionId === id);
    if (own.length) host.emit(own);
    return c.body(null, 204);
  });
  return app;
}
