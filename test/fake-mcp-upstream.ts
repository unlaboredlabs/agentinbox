/**
 * Configurable fake of a remote MCP server ("upstream") and its OAuth authorization server, served by node:http on
 * 127.0.0.1:<random port>. Hand-rolled JSON-RPC (no SDK server), so it can speak protocol generations the installed
 * SDK can't and misbehave on purpose. Deterministic, offline and fast; the broker's M1 tests all run against it.
 *
 *   const up = await startFakeMcpUpstream({ protocol: "streamable-2025", auth: { kind: "oauth" } });
 *   up.url                                   // http://127.0.0.1:<port>/mcp, the MCP endpoint (the OAuth `resource`)
 *   … connect an MCP client; on 401 it discovers, registers (DCR) and redirects:
 *   const callback = await up.oauth!.followAuthorize(authorizationUrl);   // auto-approves → redirect_uri?code&state&iss
 *   up.setTool({ name: "new_tool", inputSchema: { type: "object" } });     // pushes notifications/tools/list_changed
 *   up.requests.filter((r) => r.rpcMethod === "tools/call")               // the request log: headers, bodies, statuses
 *   await up.close();
 *
 * Protocols (`protocol`)
 *   streamable-2025   Streamable HTTP as of 2025-11-25 with sessions: `initialize` mints `Mcp-Session-Id`; later requests
 *                     without it → 400 (-32000, like the SDK's server), with an unknown or deleted one → 404 (-32001).
 *                     Negotiates 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 (anything else → 2025-11-25).
 *                     GET opens the session's standalone SSE stream (one per session, a second → 409), which carries
 *                     `notifications/tools/list_changed`; DELETE ends the session. A `MCP-Protocol-Version` header
 *                     naming an unsupported version → 400. Client `notifications/cancelled` aborts the named request.
 *   stateless-2026    The 2026-07-28 revision: no `initialize`, no sessions. Every POST must carry
 *                     `MCP-Protocol-Version` (equal to `_meta["io.modelcontextprotocol/protocolVersion"]`), `Mcp-Method`
 *                     (equal to `method`) and, for tools/call, `Mcp-Name` (equal to `params.name`; the `=?base64?…?=`
 *                     form is decoded) → otherwise 400 HeaderMismatch (-32020). An unsupported version → 400
 *                     UnsupportedProtocolVersion (-32022, data {supported, requested}); an unknown method (including
 *                     `initialize` and `ping`) → 404 -32601. `server/discover` advertises `supportedVersions`; results carry
 *                     `resultType: "complete"` and serverInfo in `_meta`; `tools/list` carries `ttlMs` and `cacheScope`.
 *                     `subscriptions/listen` opens a stream: `notifications/subscriptions/acknowledged`, then
 *                     list_changed tagged with `io.modelcontextprotocol/subscriptionId`. GET and DELETE → 405.
 *                     Closing a request's response (aborting the fetch) is its cancellation.
 *   dual              Both on one endpoint: `initialize` (or an `Mcp-Session-Id`) selects 2025 semantics, a request with
 *                     2026 `_meta` is served statelessly.
 *   sse-2024          The deprecated HTTP+SSE transport (2024-11-05): GET <path> opens the stream and sends an `endpoint`
 *                     event (`/messages?sessionId=…`); POSTs there answer 202 and the response arrives on the stream.
 *                     A POST to <path> (what a Streamable HTTP client tries first) → `legacyPostStatus` (default 405).
 *
 * Auth (`auth`)
 *   { kind: "none" }
 *   { kind: "bearer", token, header? }   exact check of `Authorization: Bearer <token>` (or of the raw value of `header`,
 *                                        e.g. "x-api-key"); otherwise 401 `WWW-Authenticate: Bearer realm="fake"`
 *   { kind: "oauth", ...FakeOAuthOptions }  the MCP endpoint is a protected resource. No or a bad token → 401
 *                                        `WWW-Authenticate: Bearer resource_metadata="…"` (+ error="invalid_token" when a
 *                                        token was sent); a token without `requiredScope` → 403 insufficient_scope.
 *     authServer "same-origin" (default, like T3) or "separate" (a second server on another port = another origin)
 *     Resource server: RFC 9728 metadata at /.well-known/oauth-protected-resource<path> ("path", default) or at
 *       /.well-known/oauth-protected-resource ("root"); `resource` is `url`.
 *     Authorization server (issuer = its origin): RFC 8414 metadata at /.well-known/oauth-authorization-server
 *       (or only OIDC at /.well-known/openid-configuration with metadataAt "oidc"); public clients
 *       (token_endpoint_auth_methods_supported ["none", "client_secret_post", "client_secret_basic"]), PKCE S256,
 *       authorization_response_iss_parameter_supported. DCR at POST /register (201; a client_secret only when the
 *       client asks for a secret-based auth method). GET /authorize auto-approves and redirects with code, state and
 *       iss (issMode "correct" | "omit" | "wrong"); an unknown client or unregistered redirect_uri → 400 HTML page,
 *       no redirect. POST /token: authorization_code (single-use code, redirect_uri match, PKCE S256 check, `resource`
 *       must equal the authorize one and, with requireResource, `url`) and refresh_token with rotation: reusing a
 *       rotated-out refresh token revokes the whole grant (like Notion). POST /revoke (RFC 7009).
 *     spaFallback: any GET the fake doesn't route answers 200 text/html (T3's web app), including
 *       /.well-known/openid-configuration.
 *   The OAuth switches are live (mutate `up.oauth.settings`): refreshGrant (false = T3: grant_types_supported
 *   ["authorization_code"], no refresh tokens, refresh → unsupported_grant_type), accessTokenTtlSec,
 *   forceInvalidGrant (every refresh → invalid_grant), rotateRefreshTokens, issMode, deny (→ error=access_denied),
 *   requireResource, requiredScope, metadataIssuer (publish a wrong `issuer`), pkce (false: S256 not advertised),
 *   dcr (false: no registration_endpoint; use `preRegistered` clients), scopesSupported. Fixed at start: authServer,
 *   prm, advertiseResourceMetadata (false: a bare `WWW-Authenticate: Bearer`), metadataAt, preRegistered.
 *
 * Private hosts: `advertisedOrigin: "http://100.104.249.49:3773"` makes the fake call itself by that origin (url,
 * resource, metadata, same-origin issuer) while listening on 127.0.0.1; `up.fetch` maps it back, standing in for the
 * broker's pinned fetch, so tailnet/LAN http upstreams (T3's forge) are testable offline.
 *
 * Tools (`tools`, default DEFAULT_TOOLS)
 *   echo          no annotations; returns its arguments as JSON text and structuredContent
 *   search_notes  readOnlyHint
 *   create_note   no annotations
 *   delete_note   destructiveHint
 *   leak_token    returns FAKE_UPSTREAM_SECRET and the bearer token it was called with (for scrubbing tests)
 *   slow          waits `ms` (argument) or `slowMs` (default: forever) unless cancelled; cancellations are recorded
 *   setTool(tool) adds or replaces (description, schema, annotations…), removeTool(name); both notify list_changed
 *   (2025 GET streams, 2026 listen streams, 2024 SSE streams) unless `notifyListChanged` is false.
 *
 * Behaviour knobs (live): latencyMs (delay before every MCP request is handled), hang (rpc methods, or
 * "tools/call:<tool>", that never answer until the client gives up), responseMode ("json" or "sse" for POST
 * answers), pageSize (tools/list pagination), ttlMs (2026 list TTL), expireSessions() (a restart: every 2025 session
 * → 404). Clock: advanceTime(ms) moves the fake's clock (token expiry) without waiting.
 *
 * Inspection: requests (every HTTP request to either server: server, method, path, headers, body, rpcMethod, rpcId,
 * and status, set when the response head goes out, so open SSE streams show 200), cancellations ({id, method, via: "notification" | "disconnect"}), sessions(), listChangedSent,
 * oauth.registrations / oauth.grants / oauth.issueTokens() (skip the browser leg) / oauth.expireAccessTokens().
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeProtocol = "streamable-2025" | "stateless-2026" | "dual" | "sse-2024";
export type JsonRpcId = string | number;
type Json = Record<string, unknown>;

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
/** A secret-looking string `leak_token` returns, for output-scrubbing tests. */
export const FAKE_UPSTREAM_SECRET = "sk-fake-upstream-0123456789abcdef0123456789abcdef";

export interface FakeToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface FakeToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Json;
  isError?: boolean;
}

export interface FakeToolContext {
  /** Aborted when the client cancels (notification or disconnect) or the fake closes. */
  signal: AbortSignal;
  /** The bearer token (or static header value) the call came with. */
  credential: string | undefined;
  era: "2024" | "2025" | "2026";
}

export interface FakeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Json;
  outputSchema?: Json;
  annotations?: FakeToolAnnotations;
  /** Default: echo the arguments. A thrown error becomes an `isError` result. */
  handler?: (args: Json, ctx: FakeToolContext) => FakeToolResult | Promise<FakeToolResult>;
}

export interface FakeOAuthSettings {
  refreshGrant: boolean;
  accessTokenTtlSec: number;
  forceInvalidGrant: boolean;
  rotateRefreshTokens: boolean;
  issMode: "correct" | "omit" | "wrong";
  deny: boolean;
  requireResource: boolean;
  requiredScope: string | null;
  metadataIssuer: string | null;
  pkce: boolean;
  dcr: boolean;
  scopesSupported: string[];
}

export interface FakeOAuthOptions extends Partial<FakeOAuthSettings> {
  authServer?: "same-origin" | "separate";
  /** Where the RFC 9728 document lives. */
  prm?: "path" | "root";
  /** Put `resource_metadata` in the 401's WWW-Authenticate (default true). */
  advertiseResourceMetadata?: boolean;
  /** Serve the AS metadata as RFC 8414 (default) or only as OIDC discovery. */
  metadataAt?: "oauth" | "oidc";
  /** Clients that exist without DCR (pre-registered). */
  preRegistered?: FakeOAuthClient[];
}

export type FakeAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string; header?: string }
  | ({ kind: "oauth" } & FakeOAuthOptions);

export interface FakeUpstreamOptions {
  protocol?: FakeProtocol;
  auth?: FakeAuth;
  /** MCP endpoint path (default "/mcp"; "/sse" is the usual one for sse-2024). */
  path?: string;
  tools?: FakeTool[];
  serverInfo?: { name: string; version: string };
  instructions?: string;
  responseMode?: "json" | "sse";
  pageSize?: number;
  ttlMs?: number;
  latencyMs?: number;
  slowMs?: number;
  notifyListChanged?: boolean;
  spaFallback?: boolean;
  legacyPostStatus?: 404 | 405;
  /** 2026 versions the server accepts (default ["2026-07-28"]). */
  supportedVersions?: string[];
  /**
   * Origin the fake names itself by (its `url`, `resource`, metadata and same-origin issuer), e.g.
   * "http://100.104.249.49:3773" for a tailnet host. It still listens on 127.0.0.1: clients reach it through
   * `up.fetch` (or their own fetch that maps `origin` to `listenOrigin`), like the broker's pinned fetch.
   */
  advertisedOrigin?: string;
}

export interface LoggedRequest {
  server: "mcp" | "auth";
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  rpcMethod?: string;
  rpcId?: JsonRpcId;
  status?: number;
}

export interface FakeOAuthClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types?: string[];
  client_name?: string;
  scope?: string;
  application_type?: string;
}

export interface FakeGrant {
  id: string;
  clientId: string;
  scope: string;
  resource: string | undefined;
  revoked: boolean;
  refreshToken: string | undefined;
  rotatedOut: string[];
}

export interface FakeOAuthServer {
  issuer: string;
  settings: FakeOAuthSettings;
  registrations: Map<string, FakeOAuthClient>;
  grants: FakeGrant[];
  /** GET the authorization URL like a browser that approves at once; returns the redirect (callback) URL. */
  followAuthorize(authorizationUrl: string | URL): Promise<URL>;
  /** Mint a grant without the browser leg (a pre-registered client "fake-client" is created if needed). */
  issueTokens(opts?: { clientId?: string; scope?: string }): { access_token: string; refresh_token?: string; expires_in: number };
  expireAccessTokens(): void;
  revokeAll(): void;
}

export interface FakeMcpUpstream {
  /** The MCP endpoint (for sse-2024, the SSE stream URL). Also the OAuth `resource`. */
  url: string;
  /** The origin in `url` (= `advertisedOrigin` when set). */
  origin: string;
  /** Where the main server really listens (http://127.0.0.1:<port>). */
  listenOrigin: string;
  /** fetch that maps `origin` to `listenOrigin`; plain fetch otherwise. */
  fetch: typeof fetch;
  protocol: FakeProtocol;
  requests: LoggedRequest[];
  cancellations: { id: JsonRpcId; method: string; via: "notification" | "disconnect" }[];
  listChangedSent: number;
  latencyMs: number;
  slowMs: number | undefined;
  hang: string[];
  responseMode: "json" | "sse";
  pageSize: number;
  ttlMs: number;
  notifyListChanged: boolean;
  legacyPostStatus: 404 | 405;
  oauth: FakeOAuthServer | undefined;
  tools(): FakeTool[];
  setTool(tool: FakeTool): void;
  removeTool(name: string): void;
  sessions(): string[];
  expireSessions(): void;
  advanceTime(ms: number): void;
  now(): number;
  close(): Promise<void>;
}

const NOTE_SCHEMA = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };

export const DEFAULT_TOOLS: FakeTool[] = [
  { name: "echo", description: "Echo the arguments back.", inputSchema: { type: "object", additionalProperties: true } },
  {
    name: "search_notes",
    description: "Search notes by text.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: { readOnlyHint: true },
    handler: (args) => text(`2 notes match ${JSON.stringify(args.query)}`),
  },
  {
    name: "create_note",
    description: "Create a note.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] },
    handler: (args) => text(`created note ${JSON.stringify(args.title)}`),
  },
  {
    name: "delete_note",
    description: "Delete a note permanently.",
    inputSchema: NOTE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: (args) => text(`deleted ${JSON.stringify(args.id)}`),
  },
  {
    name: "leak_token",
    description: "Returns secrets (for scrubbing tests).",
    inputSchema: { type: "object" },
    handler: (_args, ctx) => text(`api key ${FAKE_UPSTREAM_SECRET}; Authorization: Bearer ${ctx.credential ?? "(none)"}`),
  },
  {
    name: "slow",
    description: "Waits, for timeout and cancellation tests.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
];

function text(t: string): FakeToolResult {
  return { content: [{ type: "text", text: t }] };
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status = 200,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function token(prefix: string) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = Number.isFinite(ms) ? setTimeout(done, ms) : undefined;
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function headerRecord(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

const SPA_HTML = '<!doctype html><html><head><title>Fake web app</title></head><body><div id="root"></div></body></html>';

function openSse(res: ServerResponse, headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", ...headers });
  res.flushHeaders();
}

function sseEvent(res: ServerResponse, data: unknown, event = "message") {
  res.write(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function rpcError(id: JsonRpcId | null, e: RpcError) {
  return { jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } };
}

function decodeHeaderValue(v: string | undefined): string | undefined {
  const m = v === undefined ? null : /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : v;
}

function s256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface LegacySession {
  id: string;
  version: string;
  stream: ServerResponse | undefined;
  inflight: Map<JsonRpcId, { method: string; abort: AbortController }>;
}

interface SseSession {
  id: string;
  stream: ServerResponse;
}

interface ListenStream {
  id: JsonRpcId;
  res: ServerResponse;
  tools: boolean;
}

interface AccessToken {
  grantId: string;
  exp: number;
  scope: string;
  resource: string | undefined;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string | undefined;
  scope: string;
  exp: number;
  used: boolean;
  grantId?: string;
}

export async function startFakeMcpUpstream(opts: FakeUpstreamOptions = {}): Promise<FakeMcpUpstream> {
  const protocol = opts.protocol ?? "streamable-2025";
  const path = opts.path ?? "/mcp";
  const authCfg: FakeAuth = opts.auth ?? { kind: "none" };
  const serverInfo = opts.serverInfo ?? { name: "fake-upstream", version: "1.0.0" };
  const supported2026 = opts.supportedVersions ?? [MODERN_VERSION];
  let tools: FakeTool[] = (opts.tools ?? DEFAULT_TOOLS).map((t) => ({ ...t }));
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const closing = new AbortController();

  const legacySessions = new Map<string, LegacySession>();
  const sseSessions = new Map<string, SseSession>();
  const listenStreams = new Set<ListenStream>();

  const servers: Server[] = [];
  const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    const s = createServer((req, res) => {
      handler(req, res).catch((e: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: "fake_internal", message: String(e) });
        else res.end();
      });
    });
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };

  // ---- OAuth state -------------------------------------------------------------------------------------------------
  const oauthCfg = authCfg.kind === "oauth" ? authCfg : undefined;
  const registrations = new Map<string, FakeOAuthClient>();
  for (const c of oauthCfg?.preRegistered ?? []) registrations.set(c.client_id, c);
  const grants: FakeGrant[] = [];
  const accessTokens = new Map<string, AccessToken>();
  const refreshTokens = new Map<string, string>(); // token → grant id (current and rotated-out)
  const codes = new Map<string, AuthCode>();
  const settings: FakeOAuthSettings = {
    refreshGrant: oauthCfg?.refreshGrant ?? true,
    accessTokenTtlSec: oauthCfg?.accessTokenTtlSec ?? 3600,
    forceInvalidGrant: oauthCfg?.forceInvalidGrant ?? false,
    rotateRefreshTokens: oauthCfg?.rotateRefreshTokens ?? true,
    issMode: oauthCfg?.issMode ?? "correct",
    deny: oauthCfg?.deny ?? false,
    requireResource: oauthCfg?.requireResource ?? true,
    requiredScope: oauthCfg?.requiredScope ?? null,
    metadataIssuer: oauthCfg?.metadataIssuer ?? null,
    pkce: oauthCfg?.pkce ?? true,
    dcr: oauthCfg?.dcr ?? true,
    scopesSupported: oauthCfg?.scopesSupported ?? ["notes:read", "notes:write"],
  };

  // ---- the fake object (filled in after the servers listen) -------------------------------------------------------
  const up: FakeMcpUpstream = {
    url: "",
    origin: "",
    listenOrigin: "",
    fetch: (input, init) => {
      const u = input instanceof Request ? input.url : String(input);
      if (up.origin === up.listenOrigin || !u.startsWith(up.origin)) return fetch(input, init);
      const mapped = up.listenOrigin + u.slice(up.origin.length);
      return input instanceof Request ? fetch(new Request(mapped, input), init) : fetch(mapped, init);
    },
    protocol,
    requests: [],
    cancellations: [],
    listChangedSent: 0,
    latencyMs: opts.latencyMs ?? 0,
    slowMs: opts.slowMs,
    hang: [],
    responseMode: opts.responseMode ?? "json",
    pageSize: opts.pageSize ?? 100,
    ttlMs: opts.ttlMs ?? 60_000,
    notifyListChanged: opts.notifyListChanged ?? true,
    legacyPostStatus: opts.legacyPostStatus ?? 405,
    oauth: undefined,
    tools: () => tools.map((t) => ({ ...t })),
    setTool(tool) {
      const i = tools.findIndex((t) => t.name === tool.name);
      if (i >= 0) tools[i] = { ...tool };
      else tools.push({ ...tool });
      listChanged();
    },
    removeTool(name) {
      tools = tools.filter((t) => t.name !== name);
      listChanged();
    },
    sessions: () => [...legacySessions.keys(), ...sseSessions.keys()],
    expireSessions() {
      for (const s of legacySessions.values()) s.stream?.end();
      legacySessions.clear();
    },
    advanceTime(ms) {
      clockOffset += ms;
    },
    now,
    async close() {
      closing.abort(new Error("fake upstream closed"));
      for (const s of legacySessions.values()) s.stream?.end();
      for (const s of sseSessions.values()) s.stream.end();
      for (const l of listenStreams) l.res.end();
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections();
              s.close(() => resolve());
            }),
        ),
      );
    },
  };

  function listChanged() {
    if (!up.notifyListChanged) return;
    const note = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
    for (const s of legacySessions.values()) {
      if (s.stream && !s.stream.writableEnded) {
        sseEvent(s.stream, note);
        up.listChangedSent++;
      }
    }
    for (const s of sseSessions.values()) {
      if (!s.stream.writableEnded) {
        sseEvent(s.stream, note);
        up.listChangedSent++;
      }
    }
    for (const l of listenStreams) {
      if (l.tools && !l.res.writableEnded) {
        sseEvent(l.res, { ...note, params: { _meta: { [META_SUBSCRIPTION_ID]: l.id } } });
        up.listChangedSent++;
      }
    }
  }

  // ---- MCP method dispatch (shared by every protocol) ---------------------------------------------------------------
  function serializeTool(t: FakeTool) {
    const out: Json = { name: t.name, inputSchema: t.inputSchema };
    if (t.title !== undefined) out.title = t.title;
    if (t.description !== undefined) out.description = t.description;
    if (t.outputSchema !== undefined) out.outputSchema = t.outputSchema;
    if (t.annotations !== undefined) out.annotations = t.annotations;
    return out;
  }

  async function dispatch(method: string, params: Json, ctx: FakeToolContext): Promise<Json> {
    if (up.hang.includes(method) || (method === "tools/call" && up.hang.includes(`tools/call:${String(params.name)}`))) {
      await sleep(Number.POSITIVE_INFINITY, ctx.signal);
    }
    switch (method) {
      case "ping":
        return {};
      case "tools/list": {
        const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        if (!Number.isInteger(start) || start < 0) throw new RpcError(-32602, "Invalid cursor");
        const page = tools.slice(start, start + up.pageSize).map(serializeTool);
        const next = start + up.pageSize < tools.length ? String(start + up.pageSize) : undefined;
        return { tools: page, ...(next ? { nextCursor: next } : {}) };
      }
      case "tools/call": {
        const name = String(params.name);
        const tool = tools.find((t) => t.name === name);
        if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
        const args = (params.arguments ?? {}) as Json;
        try {
          if (name === "slow" && !tool.handler) {
            const ms = typeof args.ms === "number" ? args.ms : (up.slowMs ?? Number.POSITIVE_INFINITY);
            await sleep(ms, ctx.signal);
            return text(`slept ${ms}ms`) as unknown as Json;
          }
          const result = tool.handler ? await tool.handler(args, ctx) : { content: [{ type: "text", text: JSON.stringify(args) }], structuredContent: args };
          return result as unknown as Json;
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`, 404);
    }
  }

  /** Runs `dispatch` for one request whose answer goes on `res` (JSON or a per-request SSE stream). */
  async function answer(
    res: ServerResponse,
    id: JsonRpcId,
    method: string,
    run: (signal: AbortSignal) => Promise<Json>,
    extraHeaders: Record<string, string>,
    onAbort?: () => void,
  ): Promise<void> {
    const abort = new AbortController();
    const stop = () => abort.abort(new Error("cancelled"));
    closing.signal.addEventListener("abort", stop, { once: true });
    res.on("close", () => {
      if (!res.writableEnded) {
        if (!abort.signal.aborted) up.cancellations.push({ id, method, via: "disconnect" });
        stop();
        onAbort?.();
      }
    });
    if (up.responseMode === "sse") openSse(res, extraHeaders);
    let body: unknown;
    try {
      if (up.latencyMs > 0) await sleep(up.latencyMs, abort.signal);
      body = { jsonrpc: "2.0", id, result: await run(abort.signal) };
    } catch (e) {
      if (abort.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const err = e instanceof RpcError ? e : new RpcError(-32603, String(e));
      if (up.responseMode === "json") return sendJson(res, err.status, rpcError(id, err), extraHeaders);
      body = rpcError(id, err);
    } finally {
      closing.signal.removeEventListener("abort", stop);
    }
    if (up.responseMode === "sse") {
      sseEvent(res, body);
      res.end();
    } else sendJson(res, 200, body, extraHeaders);
  }

  function parseRpc(body: string): Json {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      throw new RpcError(-32700, "Parse error", 400);
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new RpcError(-32600, "Invalid Request: one JSON-RPC message per POST", 400);
    return msg as Json;
  }

  function acceptsBoth(req: IncomingMessage) {
    const a = req.headers.accept ?? "";
    return a.includes("application/json") && a.includes("text/event-stream");
  }

  // ---- 2025-11-25 Streamable HTTP with sessions ---------------------------------------------------------------------
  async function legacyStreamable(req: IncomingMessage, res: ServerResponse, entry: LoggedRequest, credential: string | undefined, msg?: Json) {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const fail = (status: number, code: number, message: string) => sendJson(res, status, rpcError(null, new RpcError(code, message)));
    if (req.method === "GET") {
      if (!(req.headers.accept ?? "").includes("text/event-stream")) return fail(406, -32000, "Not Acceptable: Client must accept text/event-stream");
      if (!sid) return fail(400, -32000, "Bad Request: Mcp-Session-Id header is required");
      const s = legacySessions.get(sid);
      if (!s) return fail(404, -32001, "Session not found");
      if (s.stream && !s.stream.writableEnded) return fail(409, -32000, "Conflict: Only one SSE stream is allowed per session");
      openSse(res, { "mcp-session-id": sid });
      s.stream = res;
      res.on("close", () => {
        if (s.stream === res) s.stream = undefined;
      });
      return;
    }
    if (req.method === "DELETE") {
      if (!sid) return fail(400, -32000, "Bad Request: Mcp-Session-Id header is required");
      const s = legacySessions.get(sid);
      if (!s) return fail(404, -32001, "Session not found");
      s.stream?.end();
      legacySessions.delete(sid);
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") return fail(405, -32000, "Method not allowed.");
    if (!acceptsBoth(req)) return fail(406, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream");
    if (!(req.headers["content-type"] ?? "").includes("application/json")) return fail(415, -32000, "Unsupported Media Type: Content-Type must be application/json");
    let m: Json;
    try {
      m = msg ?? parseRpc(entry.body);
    } catch (e) {
      return sendJson(res, (e as RpcError).status, rpcError(null, e as RpcError));
    }
    const method = typeof m.method === "string" ? m.method : undefined;
    const id = m.id as JsonRpcId | undefined;
    const params = (m.params ?? {}) as Json;
    if (method === "initialize") {
      if (sid) return fail(400, -32600, "Invalid Request: Server already initialized");
      const requested = String(params.protocolVersion ?? "");
      const version = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
      const s: LegacySession = { id: randomBytes(16).toString("hex"), version, stream: undefined, inflight: new Map() };
      legacySessions.set(s.id, s);
      return answer(
        res,
        id ?? 0,
        method,
        async () => ({ protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo, ...(opts.instructions ? { instructions: opts.instructions } : {}) }),
        { "mcp-session-id": s.id },
      );
    }
    if (!sid) return fail(400, -32000, "Bad Request: Mcp-Session-Id header is required");
    const s = legacySessions.get(sid);
    if (!s) return fail(404, -32001, "Session not found");
    const pv = req.headers["mcp-protocol-version"] as string | undefined;
    if (pv !== undefined && !(LEGACY_VERSIONS as readonly string[]).includes(pv)) {
      return fail(400, -32000, `Bad Request: Unsupported protocol version: ${pv} (supported versions: ${LEGACY_VERSIONS.join(", ")})`);
    }
    if (id === undefined || method === undefined) {
      if (method === "notifications/cancelled") {
        const target = params.requestId as JsonRpcId;
        const f = s.inflight.get(target);
        if (f) {
          up.cancellations.push({ id: target, method: f.method, via: "notification" });
          f.abort.abort(new Error("cancelled"));
        }
      }
      res.writeHead(202).end();
      return;
    }
    const abort = new AbortController();
    s.inflight.set(id, { method, abort });
    try {
      await answer(
        res,
        id,
        method,
        (signal) => dispatch(method, params, { signal: AbortSignal.any([signal, abort.signal]), credential, era: "2025" }),
        { "mcp-session-id": sid },
      );
    } finally {
      s.inflight.delete(id);
    }
  }

  // ---- 2026-07-28 stateless -----------------------------------------------------------------------------------------
  async function modern(req: IncomingMessage, res: ServerResponse, entry: LoggedRequest, credential: string | undefined, msg?: Json) {
    const fail = (status: number, id: JsonRpcId | null, code: number, message: string, data?: unknown) =>
      sendJson(res, status, rpcError(id, new RpcError(code, message, status, data)));
    if (req.method !== "POST") return fail(405, null, -32000, "Method Not Allowed");
    if (!acceptsBoth(req)) return fail(406, null, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream");
    let m: Json;
    try {
      m = msg ?? parseRpc(entry.body);
    } catch (e) {
      return sendJson(res, (e as RpcError).status, rpcError(null, e as RpcError));
    }
    const method = typeof m.method === "string" ? m.method : "";
    const id = m.id as JsonRpcId | undefined;
    const params = (m.params ?? {}) as Json;
    if (id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const meta = (params._meta ?? {}) as Json;
    const pvHeader = req.headers["mcp-protocol-version"] as string | undefined;
    const pvMeta = meta[META_PROTOCOL_VERSION];
    const mismatch = (why: string) => fail(400, id, -32020, `Header mismatch: ${why}`);
    if (pvHeader === undefined) return mismatch("MCP-Protocol-Version header is required");
    if (pvMeta !== pvHeader) return mismatch(`MCP-Protocol-Version header value '${pvHeader}' does not match body value '${String(pvMeta)}'`);
    const mcpMethod = req.headers["mcp-method"] as string | undefined;
    if (mcpMethod !== method) return mismatch(`Mcp-Method header value '${String(mcpMethod)}' does not match body value '${method}'`);
    if (method === "tools/call" || method === "prompts/get" || method === "resources/read") {
      const want = String(method === "resources/read" ? params.uri : params.name);
      const got = decodeHeaderValue(req.headers["mcp-name"] as string | undefined);
      if (got !== want) return mismatch(`Mcp-Name header value '${String(got)}' does not match body value '${want}'`);
    }
    if (!supported2026.includes(pvHeader)) {
      return fail(400, id, -32022, "Unsupported protocol version", { supported: protocol === "dual" ? [...supported2026, ...LEGACY_VERSIONS] : supported2026, requested: pvHeader });
    }
    const resultMeta = { [META_SERVER_INFO]: serverInfo };
    if (method === "subscriptions/listen") {
      const filter = (params.notifications ?? {}) as Json;
      const l: ListenStream = { id, res, tools: filter.toolsListChanged === true };
      openSse(res);
      sseEvent(res, {
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: { [META_SUBSCRIPTION_ID]: id }, notifications: l.tools ? { toolsListChanged: true } : {} },
      });
      listenStreams.add(l);
      res.on("close", () => listenStreams.delete(l));
      return;
    }
    return answer(res, id, method, async (signal) => {
      if (method === "server/discover") {
        return {
          resultType: "complete",
          supportedVersions: protocol === "dual" ? [...supported2026, ...LEGACY_VERSIONS] : supported2026,
          capabilities: { tools: { listChanged: true } },
          _meta: resultMeta,
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
          ttlMs: up.ttlMs,
          cacheScope: "public",
        };
      }
      if (method === "ping") throw new RpcError(-32601, "Method not found: ping", 404);
      const result = await dispatch(method, params, { signal, credential, era: "2026" });
      return { resultType: "complete", ...result, _meta: resultMeta, ...(method === "tools/list" ? { ttlMs: up.ttlMs, cacheScope: "public" } : {}) };
    }, {});
  }

  // ---- 2024-11-05 HTTP+SSE ------------------------------------------------------------------------------------------
  async function legacySse(req: IncomingMessage, res: ServerResponse, entry: LoggedRequest, url: URL, credential: string | undefined) {
    if (url.pathname === path) {
      if (req.method !== "GET") {
        res.writeHead(up.legacyPostStatus, { "content-type": "text/plain" }).end(up.legacyPostStatus === 405 ? "Method Not Allowed" : "Not Found");
        return;
      }
      const s: SseSession = { id: randomBytes(16).toString("hex"), stream: res };
      openSse(res);
      sseEvent(res, `/messages?sessionId=${s.id}`, "endpoint");
      sseSessions.set(s.id, s);
      res.on("close", () => sseSessions.delete(s.id));
      return;
    }
    // POST /messages?sessionId=…
    const s = sseSessions.get(url.searchParams.get("sessionId") ?? "");
    if (req.method !== "POST" || !s) {
      res.writeHead(s ? 405 : 404, { "content-type": "text/plain" }).end(s ? "Method Not Allowed" : "Session not found");
      return;
    }
    let m: Json;
    try {
      m = parseRpc(entry.body);
    } catch (e) {
      res.writeHead(400, { "content-type": "text/plain" }).end((e as Error).message);
      return;
    }
    res.writeHead(202, { "content-type": "text/plain" }).end("Accepted");
    const method = typeof m.method === "string" ? m.method : "";
    const id = m.id as JsonRpcId | undefined;
    if (id === undefined) return;
    const params = (m.params ?? {}) as Json;
    let body: unknown;
    try {
      if (up.latencyMs > 0) await sleep(up.latencyMs, closing.signal);
      const result =
        method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo }
          : await dispatch(method, params, { signal: closing.signal, credential, era: "2024" });
      body = { jsonrpc: "2.0", id, result };
    } catch (e) {
      if (closing.signal.aborted) return;
      body = rpcError(id, e instanceof RpcError ? e : new RpcError(-32603, String(e)));
    }
    if (!s.stream.writableEnded) sseEvent(s.stream, body);
  }

  // ---- resource-server auth -----------------------------------------------------------------------------------------
  let prmUrl = "";
  /** Returns the credential when the request may proceed; otherwise answers 401/403 and returns null. */
  function checkAuth(req: IncomingMessage, res: ServerResponse): string | undefined | null {
    if (authCfg.kind === "none") return undefined;
    if (authCfg.kind === "bearer") {
      const header = (authCfg.header ?? "authorization").toLowerCase();
      const got = req.headers[header] as string | undefined;
      const want = header === "authorization" ? `Bearer ${authCfg.token}` : authCfg.token;
      if (got === want) return authCfg.token;
      sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="fake"' });
      return null;
    }
    const auth = req.headers.authorization;
    const presented = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const t = presented ? accessTokens.get(presented) : undefined;
    const grant = t ? grants.find((g) => g.id === t.grantId) : undefined;
    const rm = authCfg.advertiseResourceMetadata === false ? "" : `resource_metadata="${prmUrl}"`;
    if (!t || !grant || grant.revoked || t.exp <= now() || t.resource !== up.url) {
      const parts = [rm, presented ? 'error="invalid_token"' : ""].filter(Boolean).join(", ");
      sendJson(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer${parts ? ` ${parts}` : ""}` });
      return null;
    }
    if (settings.requiredScope && !t.scope.split(" ").includes(settings.requiredScope)) {
      const parts = ['error="insufficient_scope"', `scope="${settings.requiredScope}"`, rm].filter(Boolean).join(", ");
      sendJson(res, 403, { error: "insufficient_scope" }, { "www-authenticate": `Bearer ${parts}` });
      return null;
    }
    return presented;
  }

  // ---- authorization server -----------------------------------------------------------------------------------------
  let issuer = "";
  function asMetadata() {
    return {
      issuer: settings.metadataIssuer ?? issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      ...(settings.dcr ? { registration_endpoint: `${issuer}/register` } : {}),
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: settings.refreshGrant ? ["authorization_code", "refresh_token"] : ["authorization_code"],
      code_challenge_methods_supported: settings.pkce ? ["S256"] : ["plain"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: settings.scopesSupported,
      authorization_response_iss_parameter_supported: true,
    };
  }

  function mintTokens(grant: FakeGrant, scope: string, resource: string | undefined) {
    const at = token("fat");
    accessTokens.set(at, { grantId: grant.id, exp: now() + settings.accessTokenTtlSec * 1000, scope, resource });
    let rt: string | undefined;
    if (settings.refreshGrant) {
      if (!grant.refreshToken || settings.rotateRefreshTokens) {
        if (grant.refreshToken) grant.rotatedOut.push(grant.refreshToken);
        rt = token("frt");
        refreshTokens.set(rt, grant.id);
        grant.refreshToken = rt;
      } else rt = grant.refreshToken;
    }
    return { access_token: at, token_type: "Bearer", expires_in: settings.accessTokenTtlSec, scope, ...(rt ? { refresh_token: rt } : {}) };
  }

  function revokeGrant(grant: FakeGrant) {
    grant.revoked = true;
    for (const [k, v] of accessTokens) if (v.grantId === grant.id) accessTokens.delete(k);
  }

  function errorPage(res: ServerResponse, msg: string) {
    sendHtml(res, 400, `<!doctype html><title>Authorization error</title><p>${msg}</p>`);
  }

  async function authServer(req: IncomingMessage, res: ServerResponse, entry: LoggedRequest, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (req.method === "GET" && p === "/.well-known/oauth-authorization-server" && oauthCfg?.metadataAt !== "oidc") {
      sendJson(res, 200, asMetadata());
      return true;
    }
    if (req.method === "GET" && p === "/.well-known/openid-configuration" && oauthCfg?.metadataAt === "oidc") {
      sendJson(res, 200, asMetadata());
      return true;
    }
    if (req.method === "POST" && p === "/register" && settings.dcr) {
      let meta: Json;
      try {
        meta = JSON.parse(entry.body) as Json;
      } catch {
        sendJson(res, 400, { error: "invalid_client_metadata", error_description: "body is not JSON" });
        return true;
      }
      const redirectUris = meta.redirect_uris;
      if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string")) {
        sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
        return true;
      }
      const method = typeof meta.token_endpoint_auth_method === "string" ? meta.token_endpoint_auth_method : "client_secret_basic";
      const client: FakeOAuthClient = {
        client_id: token("fclient"),
        redirect_uris: redirectUris as string[],
        token_endpoint_auth_method: method,
        grant_types: (meta.grant_types as string[] | undefined) ?? ["authorization_code", "refresh_token"],
        ...(typeof meta.client_name === "string" ? { client_name: meta.client_name } : {}),
        ...(typeof meta.scope === "string" ? { scope: meta.scope } : {}),
        ...(typeof meta.application_type === "string" ? { application_type: meta.application_type } : {}),
        ...(method === "none" ? {} : { client_secret: token("fsecret") }),
      };
      registrations.set(client.client_id, client);
      sendJson(res, 201, { ...client, client_id_issued_at: Math.floor(now() / 1000) });
      return true;
    }
    if (req.method === "GET" && p === "/authorize") {
      const q = url.searchParams;
      const client = registrations.get(q.get("client_id") ?? "");
      const redirectUri = q.get("redirect_uri") ?? "";
      if (!client) return errorPage(res, "Error 401: invalid_client"), true;
      if (!client.redirect_uris.includes(redirectUri)) return errorPage(res, "Error 400: redirect_uri_mismatch"), true;
      const back = new URL(redirectUri);
      const state = q.get("state");
      if (state !== null) back.searchParams.set("state", state);
      const iss = settings.issMode === "correct" ? issuer : settings.issMode === "wrong" ? "http://evil.example" : undefined;
      if (iss) back.searchParams.set("iss", iss);
      const redirectErr = (error: string, description: string) => {
        back.searchParams.set("error", error);
        back.searchParams.set("error_description", description);
        res.writeHead(302, { location: back.href }).end();
        return true;
      };
      if (q.get("response_type") !== "code") return redirectErr("unsupported_response_type", "response_type must be code");
      if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256") return redirectErr("invalid_request", "PKCE S256 is required");
      const resource = q.get("resource") ?? undefined;
      if (settings.requireResource && resource !== up.url) return redirectErr("invalid_target", `resource must be ${up.url}`);
      if (settings.deny) return redirectErr("access_denied", "The user denied the request");
      const code = token("fcode");
      codes.set(code, {
        clientId: client.client_id,
        redirectUri,
        challenge: q.get("code_challenge")!,
        resource,
        scope: q.get("scope") ?? settings.scopesSupported.join(" "),
        exp: now() + 600_000,
        used: false,
      });
      back.searchParams.set("code", code);
      res.writeHead(302, { location: back.href }).end();
      return true;
    }
    if (req.method === "POST" && (p === "/token" || p === "/revoke")) {
      const form = new URLSearchParams(entry.body);
      let clientId = form.get("client_id") ?? undefined;
      let secret = form.get("client_secret") ?? undefined;
      const basic = req.headers.authorization;
      if (basic?.startsWith("Basic ")) {
        const [id, sec] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
        clientId = decodeURIComponent(id ?? "");
        secret = decodeURIComponent(sec ?? "");
      }
      const client = clientId ? registrations.get(clientId) : undefined;
      const oauthError = (status: number, error: string, description: string) => sendJson(res, status, { error, error_description: description }, { "cache-control": "no-store" });
      if (!client || (client.client_secret !== undefined && client.client_secret !== secret)) return oauthError(401, "invalid_client", "Client authentication failed"), true;
      if (p === "/revoke") {
        const t = form.get("token") ?? "";
        const gid = accessTokens.get(t)?.grantId ?? refreshTokens.get(t);
        const g = grants.find((x) => x.id === gid && x.clientId === client.client_id);
        if (g) revokeGrant(g);
        res.writeHead(200).end();
        return true;
      }
      const resource = form.get("resource") ?? undefined;
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") {
        const c = codes.get(form.get("code") ?? "");
        if (!c || c.clientId !== client.client_id || c.exp <= now()) return oauthError(400, "invalid_grant", "Unknown or expired code"), true;
        if (c.used) {
          const g = grants.find((x) => x.id === c.grantId);
          if (g) revokeGrant(g);
          return oauthError(400, "invalid_grant", "Code already used"), true;
        }
        if (form.get("redirect_uri") !== c.redirectUri) return oauthError(400, "invalid_grant", "redirect_uri mismatch"), true;
        if (s256(form.get("code_verifier") ?? "") !== c.challenge) return oauthError(400, "invalid_grant", "PKCE verification failed"), true;
        if (resource !== c.resource || (settings.requireResource && resource !== up.url)) return oauthError(400, "invalid_target", "resource mismatch"), true;
        c.used = true;
        const g: FakeGrant = { id: token("fgrant"), clientId: client.client_id, scope: c.scope, resource, revoked: false, refreshToken: undefined, rotatedOut: [] };
        grants.push(g);
        c.grantId = g.id;
        sendJson(res, 200, mintTokens(g, c.scope, resource), { "cache-control": "no-store" });
        return true;
      }
      if (grantType === "refresh_token") {
        if (!settings.refreshGrant) return oauthError(400, "unsupported_grant_type", "refresh_token is not supported"), true;
        if (settings.forceInvalidGrant) return oauthError(400, "invalid_grant", "The refresh token is invalid (forced)"), true;
        const rt = form.get("refresh_token") ?? "";
        const g = grants.find((x) => x.id === refreshTokens.get(rt));
        if (!g || g.revoked || g.clientId !== client.client_id) return oauthError(400, "invalid_grant", "Unknown or revoked refresh token"), true;
        if (g.refreshToken !== rt) {
          revokeGrant(g);
          return oauthError(400, "invalid_grant", "Refresh token reuse detected; the grant is revoked"), true;
        }
        if (settings.requireResource && resource !== undefined && resource !== up.url) return oauthError(400, "invalid_target", "resource mismatch"), true;
        sendJson(res, 200, mintTokens(g, g.scope, resource ?? g.resource), { "cache-control": "no-store" });
        return true;
      }
      return oauthError(400, "unsupported_grant_type", `grant_type ${String(grantType)} is not supported`), true;
    }
    return false;
  }

  // ---- HTTP plumbing ------------------------------------------------------------------------------------------------
  async function common(server: "mcp" | "auth", req: IncomingMessage, res: ServerResponse): Promise<{ entry: LoggedRequest; url: URL }> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readBody(req);
    const entry: LoggedRequest = { server, method: req.method ?? "GET", path: url.pathname, query: url.search, headers: headerRecord(req), body };
    if (body && (req.headers["content-type"] ?? "").includes("application/json")) {
      try {
        const m = JSON.parse(body) as Json;
        if (typeof m.method === "string") entry.rpcMethod = m.method;
        if (typeof m.id === "string" || typeof m.id === "number") entry.rpcId = m.id;
      } catch {
        // logged as-is
      }
    }
    up.requests.push(entry);
    // Recorded when the head goes out, so long-lived SSE responses show their status while still open.
    const writeHead = res.writeHead.bind(res) as (status: number, headers?: Record<string, string>) => ServerResponse;
    res.writeHead = ((status: number, headers?: Record<string, string>) => {
      entry.status = status;
      return writeHead(status, headers);
    }) as typeof res.writeHead;
    res.on("close", () => {
      if (res.headersSent) entry.status ??= res.statusCode;
    });
    return { entry, url };
  }

  function fallback(req: IncomingMessage, res: ServerResponse) {
    if (opts.spaFallback && req.method === "GET") return sendHtml(res, 200, SPA_HTML);
    sendHtml(res, 404, "<!doctype html><title>404</title><p>Not found</p>");
  }

  const prmPath = oauthCfg?.prm === "root" ? "/.well-known/oauth-protected-resource" : `/.well-known/oauth-protected-resource${path}`;
  const separateAs = oauthCfg?.authServer === "separate";

  up.listenOrigin = await listen(async (req, res) => {
    const { entry, url } = await common("mcp", req, res);
    if (oauthCfg && req.method === "GET" && url.pathname === prmPath) {
      return sendJson(res, 200, { resource: up.url, authorization_servers: [issuer], scopes_supported: settings.scopesSupported, bearer_methods_supported: ["header"] });
    }
    if (oauthCfg && !separateAs && (await authServer(req, res, entry, url))) return;
    const isSseMessages = protocol === "sse-2024" && url.pathname === "/messages";
    if (url.pathname !== path && !isSseMessages) return fallback(req, res);
    const credential = checkAuth(req, res);
    if (credential === null) return;
    if (protocol === "sse-2024") return legacySse(req, res, entry, url, credential);
    if (protocol === "streamable-2025") return legacyStreamable(req, res, entry, credential);
    if (protocol === "stateless-2026") return modern(req, res, entry, credential);
    // dual: an initialize or a session selects 2025 semantics; 2026 `_meta` selects the stateless path
    if (req.method !== "POST" || req.headers["mcp-session-id"]) return legacyStreamable(req, res, entry, credential);
    let m: Json;
    try {
      m = parseRpc(entry.body);
    } catch (e) {
      return sendJson(res, (e as RpcError).status, rpcError(null, e as RpcError));
    }
    const meta = ((m.params as Json | undefined)?._meta ?? {}) as Json;
    if (m.method !== "initialize" && (META_PROTOCOL_VERSION in meta || req.headers["mcp-method"])) return modern(req, res, entry, credential, m);
    return legacyStreamable(req, res, entry, credential, m);
  });
  up.origin = opts.advertisedOrigin?.replace(/\/$/, "") ?? up.listenOrigin;
  up.url = `${up.origin}${path}`;
  prmUrl = `${up.origin}${prmPath}`;

  if (oauthCfg) {
    issuer = separateAs
      ? await listen(async (req, res) => {
          const { entry, url } = await common("auth", req, res);
          if (!(await authServer(req, res, entry, url))) fallback(req, res);
        })
      : up.origin;
    up.oauth = {
      issuer,
      settings,
      registrations,
      grants,
      async followAuthorize(authorizationUrl) {
        const r = await up.fetch(String(authorizationUrl), { redirect: "manual" });
        const loc = r.headers.get("location");
        if (r.status !== 302 || !loc) throw new Error(`authorize answered ${r.status}: ${await r.text()}`);
        return new URL(loc);
      },
      issueTokens(o = {}) {
        const clientId = o.clientId ?? "fake-client";
        if (!registrations.has(clientId)) registrations.set(clientId, { client_id: clientId, redirect_uris: ["http://127.0.0.1/cb"], token_endpoint_auth_method: "none" });
        const scope = o.scope ?? settings.scopesSupported.join(" ");
        const g: FakeGrant = { id: token("fgrant"), clientId, scope, resource: up.url, revoked: false, refreshToken: undefined, rotatedOut: [] };
        grants.push(g);
        const t = mintTokens(g, scope, up.url);
        return { access_token: t.access_token, ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}), expires_in: t.expires_in };
      },
      expireAccessTokens() {
        for (const t of accessTokens.values()) t.exp = 0;
      },
      revokeAll() {
        for (const g of grants) revokeGrant(g);
      },
    };
  }
  return up;
}
