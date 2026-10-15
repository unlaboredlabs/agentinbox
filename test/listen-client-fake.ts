// A small fake of the daemon's /agent/v1 API (shared/agent-api.ts), for the listen/connect client tests.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSelf, PairingPoll, PairingStart, PairingStartInput } from "../shared/agent-api.ts";
import type { EventType, MessageSummary, WebhookPayload } from "../shared/types.ts";

export const FAKE_KEY = "aib_FAKEKEY_super_secret_0123456789";

export interface StreamRequest {
  consumer: string | null;
  after: string | null;
  types: string | null;
  includeBody: string | null;
  lastEventId: string | null;
  authorization: string | null;
  userAgent: string | null;
}

export function makeEvent(seq: number, patch: { type?: EventType; message?: Partial<MessageSummary> | null; content?: WebhookPayload["data"]["content"] } = {}): WebhookPayload {
  const type = patch.type ?? "message.received";
  const message: MessageSummary | null =
    patch.message === null
      ? null
      : {
          id: `msg${seq}`,
          threadId: `thr${seq}`,
          from: { name: "Alice", email: "alice@example.com" },
          to: [{ name: null, email: "me@example.com" }],
          cc: [],
          subject: `Hello ${seq}`,
          snippet: "Hi there",
          date: "2026-10-15T09:00:00.000Z",
          labelIds: ["INBOX", "UNREAD"],
          hasAttachments: false,
          ...patch.message,
        };
  return {
    type,
    timestamp: "2026-10-15T09:00:00.000Z",
    data: {
      id: `evt_${seq}`,
      seq,
      type,
      accountId: "acc_1",
      accountEmail: "me@example.com",
      message,
      createdAt: "2026-10-15T09:00:00.000Z",
      ...(patch.content ? { content: patch.content } : {}),
    },
  };
}

export class FakeAgentApi {
  server: Server;
  port = 0;
  readonly sockets = new Set<Socket>();
  // Pairing
  pairingStarts: PairingStartInput[] = [];
  pollScript: PairingPoll[] = [];
  pollTimes: number[] = [];
  interval = 1;
  // Stream
  events: WebhookPayload[] = [];
  acked = 0;
  acks: number[] = [];
  streamRequests: StreamRequest[] = [];
  live = new Set<ServerResponse>();
  revoked: string | null = null;
  pingMs = 15_000;
  sendPings = true;
  keyValid = true;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  async start(port = 0): Promise<this> {
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Abruptly cuts every connection (simulates a network drop / daemon crash). */
  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
    this.live.clear();
  }

  /** Stops the server entirely (the port refuses connections) until `restart()`. */
  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  async restart(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await this.start(this.port);
  }

  /** Adds an event and pushes it to live streams. */
  publish(e: WebhookPayload): void {
    this.events.push(e);
    for (const res of this.live) this.write(res, e);
  }

  revoke(reason: string): void {
    this.revoked = reason;
    for (const res of this.live) {
      res.write(`event: revoked\ndata: ${JSON.stringify({ reason })}\n\n`);
      res.end();
    }
    this.live.clear();
  }

  private write(res: ServerResponse, e: WebhookPayload): void {
    res.write(`id: ${e.data.seq}\nevent: mail\ndata: ${JSON.stringify(e)}\n\n`);
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private authed(req: IncomingMessage): boolean {
    return this.keyValid && !this.revoked && req.headers.authorization === `Bearer ${FAKE_KEY}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/agent/v1/pairings") {
      this.pairingStarts.push((await this.body(req)) as unknown as PairingStartInput);
      const start: PairingStart = {
        deviceCode: "dev_secret",
        userCode: "K7QM-2XPD",
        verificationUrl: `${this.url}/pairings?code=K7QM-2XPD`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        interval: this.interval,
      };
      return this.json(res, 200, start);
    }
    if (req.method === "POST" && url.pathname === "/agent/v1/pairings/poll") {
      const b = await this.body(req);
      this.pollTimes.push(Date.now());
      if (b.deviceCode !== "dev_secret") return this.json(res, 400, { error: { code: "bad_request", message: "unknown device code" } });
      return this.json(res, 200, this.pollScript.shift() ?? { status: "pending" });
    }
    if (req.method === "GET" && url.pathname === "/agent/v1/me") {
      if (!this.authed(req)) return this.json(res, 401, { error: { code: "unauthorized", message: this.revoked ?? "invalid API key" } });
      const self: AgentSelf = {
        id: "agt_1",
        name: "Test agent",
        grants: [{ accountId: "acc_1", accountEmail: "me@example.com", capabilities: ["read", "draft"], labelScope: null, sendMode: "draft_only" }],
        mcpUrl: `${this.url}/mcp`,
        skillUrl: `${this.url}/skill.md`,
      };
      return this.json(res, 200, self);
    }
    if (req.method === "POST" && url.pathname === "/agent/v1/events/ack") {
      if (!this.authed(req)) return this.json(res, 401, { error: { code: "unauthorized", message: "invalid API key" } });
      const b = await this.body(req);
      const seq = Number(b.seq);
      this.acks.push(seq);
      this.acked = Math.max(this.acked, seq);
      return this.json(res, 200, { ackedSeq: this.acked });
    }
    if (req.method === "GET" && url.pathname === "/agent/v1/events/stream") {
      this.streamRequests.push({
        consumer: url.searchParams.get("consumer"),
        after: url.searchParams.get("after"),
        types: url.searchParams.get("types"),
        includeBody: url.searchParams.get("include_body"),
        lastEventId: (req.headers["last-event-id"] as string | undefined) ?? null,
        authorization: req.headers.authorization ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      });
      if (!this.authed(req)) return this.json(res, 401, { error: { code: "unauthorized", message: this.revoked ?? "invalid API key" } });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      const from = Math.max(Number(url.searchParams.get("after") ?? 0), Number(req.headers["last-event-id"] ?? 0), this.acked);
      for (const e of this.events) if (e.data.seq > from) this.write(res, e);
      this.live.add(res);
      const ping = setInterval(() => {
        if (this.sendPings) res.write(": ping\n\n");
      }, this.pingMs);
      res.on("close", () => {
        clearInterval(ping);
        this.live.delete(res);
      });
      return;
    }
    this.json(res, 404, { error: { code: "not_found", message: "not found" } });
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Points XDG config/state/data at a fresh temp dir. Returns the root and a restore function. */
export function isolateXdg(): { root: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agentinbox-listen-test-"));
  const saved = { c: process.env.XDG_CONFIG_HOME, s: process.env.XDG_STATE_HOME, d: process.env.XDG_DATA_HOME };
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  return {
    root,
    restore() {
      const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
      set("XDG_CONFIG_HOME", saved.c);
      set("XDG_STATE_HOME", saved.s);
      set("XDG_DATA_HOME", saved.d);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
