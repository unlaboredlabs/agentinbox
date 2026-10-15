// A local webhook receiver (node:http on 127.0.0.1) that records every request and verifies Standard
// Webhooks signatures with its own implementation (https://www.standardwebhooks.com), independent of
// server/webhooks/send.ts.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebhookPayload } from "../../shared/types.ts";

export interface ReceivedHook {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** Parsed body, or null when it isn't JSON. */
  json: WebhookPayload | null;
  receivedAt: number;
}

export type Responder = (hook: ReceivedHook, res: ServerResponse) => void | "hang";

export interface WebhookReceiver {
  /** Base URL, e.g. http://127.0.0.1:43210. Stable across stop()/start(). */
  url: string;
  port: number;
  received: ReceivedHook[];
  /** Status returned to deliveries (default 200). Use `respondWith` for custom behaviour. */
  status: number;
  respondWith(fn: Responder | null): void;
  /** Requests whose path starts with `path` (e.g. "/hooks/a"). */
  at(path: string): ReceivedHook[];
  /** Stops listening (deliveries get ECONNREFUSED) and drops open connections. */
  stop(): Promise<void>;
  /** Listens again on the same port. */
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  let custom: Responder | null = null;
  let server: Server | null = null;
  const hanging = new Set<ServerResponse>();

  const listen = (port: number) =>
    new Promise<Server>((resolve, reject) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let parsed: WebhookPayload | null = null;
          try {
            parsed = JSON.parse(body) as WebhookPayload;
          } catch {
            // not JSON
          }
          const hook: ReceivedHook = { path: req.url ?? "/", headers: req.headers, body, json: parsed, receivedAt: Date.now() };
          receiver.received.push(hook);
          if (custom && custom(hook, res) === "hang") {
            hanging.add(res);
            res.on("close", () => hanging.delete(res));
            return;
          }
          if (res.writableEnded || res.headersSent) return;
          res.writeHead(receiver.status, { "content-type": "text/plain" }).end(receiver.status < 300 ? "ok" : `receiver says ${receiver.status}`);
        });
      });
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => resolve(s));
    });

  server = await listen(0);
  const port = (server.address() as AddressInfo).port;

  const stop = async () => {
    const s = server;
    server = null;
    if (!s) return;
    for (const res of hanging) res.destroy();
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  };

  const receiver: WebhookReceiver = {
    url: `http://127.0.0.1:${port}`,
    port,
    received: [],
    status: 200,
    respondWith(fn) {
      custom = fn;
    },
    at: (path) => receiver.received.filter((h) => h.path.startsWith(path)),
    stop,
    async start() {
      if (!server) server = await listen(port);
    },
    close: stop,
  };
  return receiver;
}

// ───────────── Standard Webhooks verification (independent implementation) ─────────────

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies `webhook-id`, `webhook-timestamp` and `webhook-signature` per the Standard Webhooks spec:
 * HMAC-SHA256 over "{id}.{timestamp}.{body}" keyed with base64-decode(secret minus "whsec_"),
 * signature list "v1,<base64> v1,<base64>…", timestamp within the tolerance.
 */
export function verifyStandardWebhook(secret: string, hook: Pick<ReceivedHook, "headers" | "body">, toleranceSeconds = 300): VerifyResult {
  const h = (name: string) => {
    const v = hook.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = h("webhook-id");
  const ts = h("webhook-timestamp");
  const sigs = h("webhook-signature");
  if (!id || !ts || !sigs) return { ok: false, reason: "missing webhook-id/timestamp/signature header" };
  if (!/^\d+$/.test(ts)) return { ok: false, reason: `bad timestamp ${ts}` };
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (skew > toleranceSeconds) return { ok: false, reason: `timestamp outside tolerance (${Math.round(skew)} s)` };
  if (!secret.startsWith("whsec_")) return { ok: false, reason: "secret is not whsec_…" };
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${hook.body}`).digest();
  for (const part of sigs.split(" ")) {
    const [version, b64] = part.split(",", 2);
    if (version !== "v1" || !b64) continue;
    const got = Buffer.from(b64, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching v1 signature" };
}
