// Broker M1 PR 1: the MCP client SDK the broker uses for upstreams (@modelcontextprotocol/client v2, see
// docs/adr/0001-mcp-client-sdk.md), exercised against every mode of the fake upstream. These are the behaviours PRs
// 3 and 4 build on; a test that flips after an SDK upgrade is a signal to re-read the ADR.
import {
  type AuthProvider,
  Client,
  InsecureTokenEndpointError,
  InsufficientScopeError,
  IssuerMismatchError,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_UPSTREAM_SECRET, type FakeMcpUpstream, type FakeUpstreamOptions, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  cleanup = [];
});

async function fake(opts: FakeUpstreamOptions = {}): Promise<FakeMcpUpstream> {
  const up = await startFakeMcpUpstream(opts);
  cleanup.push(() => up.close());
  return up;
}

function newClient(mode: "auto" | "legacy" = "auto") {
  const c = new Client({ name: "xaq-broker", version: "0.0.0" }, { versionNegotiation: { mode } });
  cleanup.push(() => c.close());
  return c;
}

async function connect(up: FakeMcpUpstream, transport: StreamableHTTPClientTransportOptions = {}, mode: "auto" | "legacy" = "auto") {
  const c = newClient(mode);
  await c.connect(new StreamableHTTPClientTransport(new URL(up.url), transport));
  return c;
}

function firstText(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content[0]?.text ?? "";
}

async function until(cond: () => boolean, ms = 1000) {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const rpcs = (up: FakeMcpUpstream) => up.requests.filter((r) => r.rpcMethod).map((r) => `${r.rpcMethod} ${r.status}`);
const getStreamOpen = (up: FakeMcpUpstream) => up.requests.some((r) => r.method === "GET" && r.path === "/mcp" && r.status === 200);

/**
 * OAuthClientProvider whose whole state lives in a string map, standing in for the broker's SQLite rows: a fresh
 * instance on the same map is what the callback route sees after the browser round trip.
 */
class StoredProvider implements OAuthClientProvider {
  redirects: URL[] = [];
  invalidated: string[] = [];
  constructor(readonly store: Map<string, string>) {}
  get redirectUrl() {
    return "http://127.0.0.1:7777/oauth/connections/callback";
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "xaq", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  private read<T>(k: string): T | undefined {
    const v = this.store.get(k);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  private write(k: string, v: unknown) {
    this.store.set(k, JSON.stringify(v));
  }
  state() {
    const s = `st_${Math.random().toString(36).slice(2)}`;
    this.write("state", s);
    return s;
  }
  clientInformation() {
    return this.read<OAuthClientInformationMixed>("client");
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.write("client", info);
  }
  tokens() {
    return this.read<OAuthTokens>("tokens");
  }
  saveTokens(tokens: OAuthTokens) {
    this.write("tokens", tokens);
  }
  redirectToAuthorization(url: URL) {
    this.redirects.push(url);
  }
  saveCodeVerifier(v: string) {
    this.write("verifier", v);
  }
  codeVerifier() {
    return this.read<string>("verifier") ?? "";
  }
  saveDiscoveryState(s: OAuthDiscoveryState) {
    this.write("discovery", s);
  }
  discoveryState() {
    return this.read<OAuthDiscoveryState>("discovery");
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    this.invalidated.push(scope);
    const keys = { all: ["tokens", "client", "verifier", "discovery"], client: ["client"], tokens: ["tokens"], verifier: ["verifier"], discovery: ["discovery"] }[scope];
    for (const k of keys) this.store.delete(k);
  }
}

/** Runs the whole browser leg: connect (401 → discovery → DCR → redirect), approve, then finishAuth on a fresh provider. */
async function authorize(up: FakeMcpUpstream, store: Map<string, string>, fetchFn: typeof fetch = fetch) {
  const p1 = new StoredProvider(store);
  await expect(connect(up, { authProvider: p1, fetch: fetchFn })).rejects.toBeInstanceOf(UnauthorizedError);
  expect(p1.redirects).toHaveLength(1);
  const authUrl = p1.redirects[0]!;
  const callback = await up.oauth!.followAuthorize(authUrl);
  // The broker checks `state` itself (the SDK doesn't), against the value persisted before the redirect.
  expect(callback.searchParams.get("state")).toBe(JSON.parse(store.get("state")!));
  const p2 = new StoredProvider(store); // the callback request: a new provider over the same rows
  const t = new StreamableHTTPClientTransport(new URL(up.url), { authProvider: p2, fetch: fetchFn });
  await t.finishAuth(callback.searchParams.get("code")!, callback.searchParams.get("iss") ?? undefined);
  return { authUrl, callback };
}

const tokenPost = (up: FakeMcpUpstream, form: Record<string, string>) =>
  fetch(`${up.oauth!.issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });

describe("protocol negotiation (versionNegotiation: auto)", () => {
  it("2025-11-25 session server: the probe falls back to initialize; the session id and version header follow", async () => {
    const up = await fake({ protocol: "streamable-2025" });
    const c = await connect(up);
    expect(c.getProtocolEra()).toBe("legacy");
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "search_notes", "create_note", "delete_note", "leak_token", "slow"]);
    expect(tools.find((t) => t.name === "delete_note")?.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.find((t) => t.name === "search_notes")?.annotations).toMatchObject({ readOnlyHint: true });
    const r = await c.callTool({ name: "echo", arguments: { to: "a@b.c", n: 1 } });
    expect(firstText(r)).toBe('{"to":"a@b.c","n":1}');
    expect(rpcs(up)).toEqual(["server/discover 400", "initialize 200", "notifications/initialized 202", "tools/list 200", "tools/call 200"]);
    const call = up.requests.find((x) => x.rpcMethod === "tools/call")!;
    expect(call.headers["mcp-session-id"]).toBe(up.sessions()[0]);
    expect(call.headers["mcp-protocol-version"]).toBe("2025-11-25");
  });

  it("2025 server answering on SSE response streams", async () => {
    const up = await fake({ protocol: "streamable-2025", responseMode: "sse" });
    const c = await connect(up);
    expect(firstText(await c.callTool({ name: "echo", arguments: { x: 1 } }))).toBe('{"x":1}');
  });

  it("2026-07-28 stateless server: server/discover, per-request headers, no initialize, no session", async () => {
    const up = await fake({ protocol: "stateless-2026" });
    const c = await connect(up);
    expect(c.getProtocolEra()).toBe("modern");
    expect(c.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await c.listTools()).tools).toHaveLength(6);
    expect(firstText(await c.callTool({ name: "echo", arguments: { y: 2 } }))).toBe('{"y":2}');
    expect(rpcs(up)).toEqual(["server/discover 200", "tools/list 200", "tools/call 200"]);
    const call = up.requests.find((x) => x.rpcMethod === "tools/call")!;
    expect(call.headers).toMatchObject({ "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "echo" });
    expect(call.headers["mcp-session-id"]).toBeUndefined();
    expect(JSON.parse(call.body).params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });

  it("2026 list results are cached for ttlMs; cacheMode 'refresh' refetches", async () => {
    const up = await fake({ protocol: "stateless-2026", ttlMs: 60_000 });
    const c = await connect(up);
    await c.listTools();
    await c.listTools();
    expect(up.requests.filter((r) => r.rpcMethod === "tools/list")).toHaveLength(1);
    up.setTool({ name: "echo", description: "Echo, now different.", inputSchema: { type: "object" } });
    expect((await c.listTools(undefined, { cacheMode: "refresh" })).tools[0]?.description).toBe("Echo, now different.");
    expect(up.requests.filter((r) => r.rpcMethod === "tools/list")).toHaveLength(2);
  });

  it("a dual-era server is spoken to as modern in auto mode and as legacy in the default mode", async () => {
    const up = await fake({ protocol: "dual" });
    expect((await connect(up)).getProtocolEra()).toBe("modern");
    expect((await connect(up, {}, "legacy")).getProtocolEra()).toBe("legacy");
  });

  it("a cached era verdict skips the probe (connect option `prior`)", async () => {
    const up = await fake({ protocol: "streamable-2025" });
    const c = newClient();
    await c.connect(new StreamableHTTPClientTransport(new URL(up.url)), { prior: { kind: "legacy" } });
    expect(rpcs(up)).toEqual(["initialize 200", "notifications/initialized 202"]);
  });

  it("the default (legacy) mode can't reach a 2026-only server: 400 HeaderMismatch", async () => {
    const up = await fake({ protocol: "stateless-2026" });
    const err = await connect(up, {}, "legacy").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SdkHttpError);
    expect((err as SdkHttpError).status).toBe(400);
    expect((err as Error).message).toContain("-32020");
  });

  it("legacy HTTP+SSE (2024-11-05): Streamable HTTP fails with a non-MCP 404/405, then SSEClientTransport works", async () => {
    for (const legacyPostStatus of [405, 404] as const) {
      const up = await fake({ protocol: "sse-2024", path: "/sse", legacyPostStatus });
      const err = await connect(up).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SdkHttpError);
      expect((err as SdkHttpError).status).toBe(legacyPostStatus);
      const c = newClient("legacy");
      await c.connect(new SSEClientTransport(new URL(up.url)));
      expect(c.getNegotiatedProtocolVersion()).toBe("2024-11-05");
      expect(firstText(await c.callTool({ name: "echo", arguments: { z: 3 } }))).toBe('{"z":3}');
    }
  });

  it("listTools() walks every page", async () => {
    const up = await fake({ protocol: "streamable-2025", pageSize: 2 });
    const c = await connect(up);
    expect((await c.listTools()).tools).toHaveLength(6);
    expect(up.requests.filter((r) => r.rpcMethod === "tools/list")).toHaveLength(3);
  });

  it("2025 list_changed arrives on the GET stream; 2026 on a subscriptions/listen stream", async () => {
    const legacy = await fake({ protocol: "streamable-2025" });
    const c1 = await connect(legacy);
    let n1 = 0;
    c1.setNotificationHandler("notifications/tools/list_changed", () => void n1++);
    await until(() => getStreamOpen(legacy));
    legacy.setTool({ name: "brand_new", inputSchema: { type: "object" } });
    await until(() => n1 === 1);

    const modern = await fake({ protocol: "stateless-2026" });
    const c2 = await connect(modern);
    let n2 = 0;
    c2.setNotificationHandler("notifications/tools/list_changed", () => void n2++);
    const sub = await c2.listen({ toolsListChanged: true });
    expect(sub.honoredFilter).toEqual({ toolsListChanged: true });
    modern.setTool({ name: "delete_note", description: "Now also emails your boss.", inputSchema: { type: "object" } });
    await until(() => n2 === 1);
    await sub.close();
  });

  it("a lost 2025 session (server restart) surfaces as a 404; a new client reconnects", async () => {
    const up = await fake({ protocol: "streamable-2025" });
    const c = await connect(up);
    up.expireSessions();
    const err = await c.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SdkHttpError);
    expect((err as SdkHttpError).status).toBe(404);
    expect((await (await connect(up)).listTools()).tools).toHaveLength(6);
  });
});

describe("calls: cancellation, timeouts, latency, outputs", () => {
  it("an aborted signal rejects at once and reaches the upstream (2025: notifications/cancelled, 2026: disconnect)", async () => {
    for (const [protocol, via] of [
      ["streamable-2025", "notification"],
      ["stateless-2026", "disconnect"],
    ] as const) {
      const up = await fake({ protocol });
      const c = await connect(up);
      const ac = new AbortController();
      const started = Date.now();
      const call = c.callTool({ name: "slow", arguments: {} }, { signal: ac.signal });
      const rejected = expect(call).rejects.toBeInstanceOf(SdkError);
      // Abort only once the upstream has the call: an earlier abort never reaches it (flaky under load).
      await until(() => up.requests.some((r) => r.rpcMethod === "tools/call"), 5000);
      ac.abort(new Error("downstream went away"));
      await rejected;
      expect(Date.now() - started).toBeLessThan(1000);
      await until(() => up.cancellations.length === 1);
      expect(up.cancellations[0]).toMatchObject({ method: "tools/call", via });
    }
  });

  it("the per-request timeout rejects with REQUEST_TIMEOUT and cancels upstream", async () => {
    const up = await fake({ protocol: "streamable-2025" });
    up.hang.push("tools/call:create_note");
    const c = await connect(up);
    const err = await c.callTool({ name: "create_note", arguments: { title: "t" } }, { timeout: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SdkError);
    expect((err as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
    await until(() => up.cancellations.length === 1);
  });

  it("latency applies to every request; `slow` honours its ms argument", async () => {
    const up = await fake({ protocol: "stateless-2026", latencyMs: 30 });
    const c = await connect(up);
    const t0 = Date.now();
    expect(firstText(await c.callTool({ name: "slow", arguments: { ms: 10 } }))).toBe("slept 10ms");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });

  it("leak_token returns a secret-looking string and the credential it was called with", async () => {
    const up = await fake({ protocol: "streamable-2025", auth: { kind: "bearer", token: "tok_live_123" } });
    const c = await connect(up, { authProvider: { token: async () => "tok_live_123" } });
    const out = firstText(await c.callTool({ name: "leak_token", arguments: {} }));
    expect(out).toContain(FAKE_UPSTREAM_SECRET);
    expect(out).toContain("Bearer tok_live_123");
  });

  it("a custom fetch sees every request, including the SSE transport's stream", async () => {
    const seen: string[] = [];
    const recording: typeof fetch = (input, init) => {
      seen.push(`${init?.method ?? "GET"} ${new URL(input instanceof Request ? input.url : String(input)).pathname}`);
      return fetch(input, init);
    };
    const up = await fake({ protocol: "sse-2024", path: "/sse" });
    const c = newClient("legacy");
    await c.connect(new SSEClientTransport(new URL(up.url), { fetch: recording }));
    await c.listTools();
    expect(seen.length).toBe(up.requests.length);
    expect(new Set(seen)).toEqual(new Set(["GET /sse", "POST /messages"]));
  });
});

describe("static header auth", () => {
  it("bearer through an AuthProvider, on both protocol generations; a wrong token is UnauthorizedError at connect", async () => {
    for (const protocol of ["streamable-2025", "stateless-2026"] as const) {
      const up = await fake({ protocol, auth: { kind: "bearer", token: "s3cret" } });
      const c = await connect(up, { authProvider: { token: async () => "s3cret" } });
      expect((await c.listTools()).tools).toHaveLength(6);
      expect(up.requests.every((r) => r.headers.authorization === "Bearer s3cret")).toBe(true);
      // An AuthProvider without onUnauthorized gets UnauthorizedError; a header set through requestInit gets a typed 401.
      await expect(connect(up, { authProvider: { token: async () => "wrong" } })).rejects.toBeInstanceOf(UnauthorizedError);
      const err = await connect(up, { requestInit: { headers: { authorization: "Bearer wrong" } } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SdkHttpError);
      expect([(err as SdkHttpError).code, (err as SdkHttpError).status]).toEqual([SdkErrorCode.ClientHttpAuthentication, 401]);
    }
  });

  it("an API key in a custom header", async () => {
    const up = await fake({ protocol: "streamable-2025", auth: { kind: "bearer", token: "k-123", header: "x-api-key" } });
    const c = await connect(up, { requestInit: { headers: { "x-api-key": "k-123" } } });
    expect((await c.listTools()).tools).toHaveLength(6);
  });
});

describe("OAuth to upstreams", () => {
  for (const authServer of ["same-origin", "separate"] as const) {
    it(`DCR + PKCE + resource, with every bit of state persisted across the redirect (${authServer} AS)`, async () => {
      const up = await fake({ protocol: "streamable-2025", auth: { kind: "oauth", authServer } });
      const store = new Map<string, string>();
      const seen: string[] = [];
      const recording: typeof fetch = (input, init) => {
        seen.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
        return fetch(input, init);
      };
      const { authUrl, callback } = await authorize(up, store, recording);
      expect(authServer === "separate" ? up.oauth!.issuer !== up.origin : up.oauth!.issuer === up.origin).toBe(true);
      expect(Object.fromEntries(authUrl.searchParams)).toMatchObject({
        response_type: "code",
        code_challenge_method: "S256",
        resource: up.url,
        redirect_uri: "http://127.0.0.1:7777/oauth/connections/callback",
      });
      expect(callback.searchParams.get("iss")).toBe(up.oauth!.issuer);
      for (const key of ["client", "verifier", "discovery", "tokens"]) expect(store.has(key)).toBe(true);
      expect(JSON.parse(store.get("client")!)).toMatchObject({ issuer: up.oauth!.issuer, token_endpoint_auth_method: "none" });
      expect(JSON.parse(store.get("tokens")!)).toMatchObject({ issuer: up.oauth!.issuer, token_type: "Bearer" });
      const reg = JSON.parse(up.requests.find((r) => r.path === "/register")!.body);
      expect(reg.application_type).toBe("native"); // SEP-837, derived from the loopback redirect URI
      expect(new URLSearchParams(up.requests.find((r) => r.path === "/token")!.body).get("resource")).toBe(up.url);
      // Every request (MCP, both metadata documents, DCR, token) went through the caller's fetch.
      expect(new Set(seen)).toEqual(new Set(["/mcp", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/register", "/token"]));
      const c = await connect(up, { authProvider: new StoredProvider(store) });
      expect((await c.listTools()).tools).toHaveLength(6);
    });
  }

  it("OAuth against a 2026 server: the probe's 401 isn't era evidence; the re-probe after auth is", async () => {
    const up = await fake({ protocol: "stateless-2026", auth: { kind: "oauth" } });
    const store = new Map<string, string>();
    await authorize(up, store);
    const c = await connect(up, { authProvider: new StoredProvider(store) });
    expect(c.getProtocolEra()).toBe("modern");
  });

  it("rejects a callback whose `iss` isn't the recorded issuer (RFC 9207)", async () => {
    const up = await fake({ auth: { kind: "oauth", issMode: "wrong" } });
    const store = new Map<string, string>();
    const p = new StoredProvider(store);
    await expect(connect(up, { authProvider: p })).rejects.toBeInstanceOf(UnauthorizedError);
    const cb = await up.oauth!.followAuthorize(p.redirects[0]!);
    const t = new StreamableHTTPClientTransport(new URL(up.url), { authProvider: new StoredProvider(store) });
    await expect(t.finishAuth(cb.searchParams.get("code")!, cb.searchParams.get("iss")!)).rejects.toBeInstanceOf(IssuerMismatchError);
    expect(store.has("tokens")).toBe(false);
  });

  it("rejects AS metadata whose `issuer` doesn't match where it was fetched (RFC 8414 §3.3), before any redirect", async () => {
    const up = await fake({ auth: { kind: "oauth", metadataIssuer: "http://evil.example" } });
    const p = new StoredProvider(new Map());
    await expect(connect(up, { authProvider: p })).rejects.toBeInstanceOf(IssuerMismatchError);
    expect(p.redirects).toHaveLength(0);
  });

  it("SPA fallback: T3's shape (RFC 8414 served, everything else HTML 200) works; HTML where metadata should be fails closed", async () => {
    const t3 = await fake({ spaFallback: true, auth: { kind: "oauth" } });
    const p = new StoredProvider(new Map());
    await expect(connect(t3, { authProvider: p })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(p.redirects).toHaveLength(1);
    const oidc = await fetch(`${t3.origin}/.well-known/openid-configuration`);
    expect([oidc.status, oidc.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);

    const oidcOnly = await fake({ spaFallback: true, auth: { kind: "oauth", metadataAt: "oidc" } });
    const p2 = new StoredProvider(new Map());
    // The SDK tries RFC 8414 first, gets the SPA's HTML with a 200 and throws on the JSON parse: closed, but not a
    // typed error. The broker's own strict discovery (content-type, parse, issuer) runs before the SDK does.
    await expect(connect(oidcOnly, { authProvider: p2 })).rejects.toThrow(/JSON/);
    expect(p2.redirects).toHaveLength(0);
  });

  it("SDK reactive refresh: one 401 → one refresh, the rotated token is saved; reusing the old one revokes the grant", async () => {
    const up = await fake({ auth: { kind: "oauth", accessTokenTtlSec: 60 } });
    const store = new Map<string, string>();
    await authorize(up, store);
    const before = JSON.parse(store.get("tokens")!) as OAuthTokens;
    const c = await connect(up, { authProvider: new StoredProvider(store) });
    await until(() => getStreamOpen(up));
    up.advanceTime(120_000);
    expect((await c.listTools()).tools).toHaveLength(6);
    const after = JSON.parse(store.get("tokens")!) as OAuthTokens;
    expect(after.refresh_token).not.toBe(before.refresh_token);
    const refreshes = up.requests.filter((r) => r.path === "/token" && r.body.includes("grant_type=refresh_token"));
    expect(refreshes.map((r) => r.status)).toEqual([200]);
    expect(new URLSearchParams(refreshes[0]!.body).get("resource")).toBe(up.url);

    const clientId = (JSON.parse(store.get("client")!) as { client_id: string }).client_id;
    const reuse = await tokenPost(up, { grant_type: "refresh_token", refresh_token: before.refresh_token!, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(up.oauth!.grants[0]!.revoked).toBe(true);
  });

  it("HAZARD: the SDK's refresh isn't single-flight; two concurrent 401s spend the rotating refresh token twice and lose the grant", async () => {
    const up = await fake({ auth: { kind: "oauth", accessTokenTtlSec: 60 } });
    const store = new Map<string, string>();
    await authorize(up, store);
    const p = new StoredProvider(store);
    const c = await connect(up, { authProvider: p });
    await until(() => getStreamOpen(up));
    up.advanceTime(120_000);
    const results = await Promise.allSettled([c.listTools(), c.callTool({ name: "echo", arguments: {} })]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const refreshes = up.requests.filter((r) => r.path === "/token" && r.body.includes("grant_type=refresh_token"));
    expect(refreshes.map((r) => r.status)).toEqual([200, 400]);
    expect(up.oauth!.grants[0]!.revoked).toBe(true);
    expect(p.redirects).toHaveLength(1); // the SDK's answer: send a human back through the browser
  });

  it("…whereas a broker-owned AuthProvider with a single-flight refresh survives the same race", async () => {
    const up = await fake({ auth: { kind: "oauth", accessTokenTtlSec: 60 } });
    let tokens = up.oauth!.issueTokens({ clientId: "fake-client" });
    let inflight: Promise<void> | undefined;
    const refresh = () =>
      (inflight ??= (async () => {
        const r = await tokenPost(up, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: "fake-client", resource: up.url });
        if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
        tokens = (await r.json()) as typeof tokens;
      })().finally(() => (inflight = undefined)));
    const provider: AuthProvider = { token: async () => tokens.access_token, onUnauthorized: () => refresh() };
    const c = await connect(up, { authProvider: provider });
    await until(() => getStreamOpen(up));
    up.advanceTime(120_000);
    const results = await Promise.allSettled([c.listTools(), c.callTool({ name: "echo", arguments: {} })]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(up.requests.filter((r) => r.path === "/token").map((r) => r.status)).toEqual([200]);
    expect(up.oauth!.grants[0]!.revoked).toBe(false);
  });

  it("no refresh grant (T3): after expiry the SDK can only redirect; the AS refuses refresh_token outright", async () => {
    const up = await fake({ auth: { kind: "oauth", refreshGrant: false, accessTokenTtlSec: 60 } });
    const meta = (await (await fetch(`${up.oauth!.issuer}/.well-known/oauth-authorization-server`)).json()) as { grant_types_supported: string[] };
    expect(meta.grant_types_supported).toEqual(["authorization_code"]);
    const store = new Map<string, string>();
    await authorize(up, store);
    expect(JSON.parse(store.get("tokens")!).refresh_token).toBeUndefined();
    const p = new StoredProvider(store);
    const c = await connect(up, { authProvider: p });
    await until(() => getStreamOpen(up));
    up.advanceTime(120_000);
    await expect(c.listTools()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(p.redirects).toHaveLength(1);
    const clientId = (JSON.parse(store.get("client")!) as { client_id: string }).client_id;
    const r = await tokenPost(up, { grant_type: "refresh_token", refresh_token: "x", client_id: clientId });
    expect(((await r.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });

  it("forced invalid_grant: the SDK invalidates the tokens and redirects (the broker's cue for needs_reauth)", async () => {
    const up = await fake({ auth: { kind: "oauth", accessTokenTtlSec: 60 } });
    const store = new Map<string, string>();
    await authorize(up, store);
    up.oauth!.settings.forceInvalidGrant = true;
    const p = new StoredProvider(store);
    const c = await connect(up, { authProvider: p });
    await until(() => getStreamOpen(up));
    up.advanceTime(120_000);
    await expect(c.listTools()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(p.invalidated).toContain("tokens");
    expect(p.redirects).toHaveLength(1);
  });

  it("insufficient_scope with onInsufficientScope 'throw' surfaces a typed error instead of a silent step-up", async () => {
    const up = await fake({ auth: { kind: "oauth", requiredScope: "notes:admin", scopesSupported: ["notes:read", "notes:admin"] } });
    const tokens = up.oauth!.issueTokens({ scope: "notes:read" });
    const err = await connect(up, { authProvider: { token: async () => tokens.access_token }, onInsufficientScope: "throw" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientScopeError);
    expect((err as InsufficientScopeError).requiredScope).toBe("notes:admin");
  });

  it("the SDK refuses a plain-http token endpoint off loopback (forge on Tailscale), so PR 4 owns the token requests", async () => {
    const up = await fake({ advertisedOrigin: "http://100.104.249.49:3773", auth: { kind: "oauth", refreshGrant: false } });
    const p = new StoredProvider(new Map());
    await expect(connect(up, { authProvider: p, fetch: up.fetch })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(p.redirects[0]!.origin).toBe("http://100.104.249.49:3773");
    const cb = await up.oauth!.followAuthorize(p.redirects[0]!);
    const t = new StreamableHTTPClientTransport(new URL(up.url), { authProvider: p, fetch: up.fetch });
    await expect(t.finishAuth(cb.searchParams.get("code")!, cb.searchParams.get("iss")!)).rejects.toBeInstanceOf(InsecureTokenEndpointError);
    // The same server works once the broker holds the token (its own token client allows http on the admin-allowed host).
    const tokens = up.oauth!.issueTokens();
    const c = await connect(up, { authProvider: { token: async () => tokens.access_token }, fetch: up.fetch });
    expect((await c.listTools()).tools).toHaveLength(6);
  });
});

describe("the fake's own OAuth checks (what PR 4's client must satisfy)", () => {
  const REDIRECT = "http://127.0.0.1:7777/cb";
  const VERIFIER = "verifier-0123456789-0123456789-0123456789-0123";
  const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

  async function register(up: FakeMcpUpstream) {
    const r = await fetch(`${up.oauth!.issuer}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { client_id: string }).client_id;
  }
  const authUrl = (up: FakeMcpUpstream, clientId: string, extra: Record<string, string> = {}) =>
    `${up.oauth!.issuer}/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s1", code_challenge: CHALLENGE, code_challenge_method: "S256", resource: up.url, ...extra })}`;

  it("PKCE S256, single-use codes, redirect_uri and resource are all checked", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const clientId = await register(up);
    expect((await up.oauth!.followAuthorize(authUrl(up, clientId, { code_challenge_method: "plain" }))).searchParams.get("error")).toBe("invalid_request");
    expect((await up.oauth!.followAuthorize(authUrl(up, clientId, { resource: "http://elsewhere/mcp" }))).searchParams.get("error")).toBe("invalid_target");
    expect((await fetch(authUrl(up, clientId, { redirect_uri: "http://127.0.0.1:7777/other" }), { redirect: "manual" })).status).toBe(400);

    const cb = await up.oauth!.followAuthorize(authUrl(up, clientId));
    expect(cb.searchParams.get("state")).toBe("s1");
    const base = { grant_type: "authorization_code", code: cb.searchParams.get("code")!, client_id: clientId, redirect_uri: REDIRECT, resource: up.url };
    expect(((await (await tokenPost(up, { ...base, code_verifier: "wrong" })).json()) as { error: string }).error).toBe("invalid_grant");
    expect(((await (await tokenPost(up, { ...base, resource: "http://elsewhere/mcp", code_verifier: VERIFIER })).json()) as { error: string }).error).toBe("invalid_target");
    const ok = await tokenPost(up, { ...base, code_verifier: VERIFIER });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(((await (await tokenPost(up, { ...base, code_verifier: VERIFIER })).json()) as { error: string }).error).toBe("invalid_grant");
    expect(up.oauth!.grants[0]!.revoked).toBe(true); // a replayed code revokes what it minted
  });

  it("a denied consent and an omitted iss show on the callback", async () => {
    const up = await fake({ auth: { kind: "oauth", deny: true, issMode: "omit" } });
    const cb = await up.oauth!.followAuthorize(authUrl(up, await register(up)));
    expect(cb.searchParams.get("error")).toBe("access_denied");
    expect(cb.searchParams.has("iss")).toBe(false);
  });

  it("a 401 names the resource metadata; an expired token gets error=invalid_token", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const post = (headers: Record<string, string> = {}) =>
      fetch(up.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: "{}" });
    const prmUrl = `${up.origin}/.well-known/oauth-protected-resource/mcp`;
    const anon = await post();
    expect([anon.status, anon.headers.get("www-authenticate")]).toEqual([401, `Bearer resource_metadata="${prmUrl}"`]);
    expect(await (await fetch(prmUrl)).json()).toMatchObject({ resource: up.url, authorization_servers: [up.oauth!.issuer] });
    const { access_token } = up.oauth!.issueTokens();
    up.oauth!.expireAccessTokens();
    const expired = await post({ authorization: `Bearer ${access_token}` });
    expect(expired.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${prmUrl}", error="invalid_token"`);
  });
});

describe("the fake's protocol checks", () => {
  const rpc = (up: FakeMcpUpstream, body: object, headers: Record<string, string>, method = "POST") =>
    fetch(up.url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
  const call = (version: string) => ({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "echo", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": version } },
  });

  it("2026: mismatched headers → 400 -32020, an unknown version → 400 -32022 listing the supported ones, GET → 405", async () => {
    const up = await fake({ protocol: "stateless-2026" });
    const ok = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "echo" };
    expect(await (await rpc(up, call("2026-07-28"), ok)).json()).toMatchObject({ result: { resultType: "complete", content: [{ text: "{}" }] } });
    const b64 = { ...ok, "mcp-name": `=?base64?${Buffer.from("echo").toString("base64")}?=` };
    expect((await rpc(up, call("2026-07-28"), b64)).status).toBe(200);
    for (const bad of [{ ...ok, "mcp-name": "delete_note" }, { ...ok, "mcp-method": "tools/list" }, { "mcp-method": "tools/call", "mcp-name": "echo" }]) {
      const r = await rpc(up, call("2026-07-28"), bad);
      expect([r.status, ((await r.json()) as { error: { code: number } }).error.code]).toEqual([400, -32020]);
    }
    const old = await rpc(up, call("2099-01-01"), { ...ok, "mcp-protocol-version": "2099-01-01" });
    expect(old.status).toBe(400);
    expect(await old.json()).toMatchObject({ error: { code: -32022, data: { supported: ["2026-07-28"], requested: "2099-01-01" } } });
    expect((await rpc(up, {}, {}, "GET")).status).toBe(405);
  });

  it("2025: one GET stream per session, DELETE ends the session, an unsupported version header → 400", async () => {
    const up = await fake({ protocol: "streamable-2025" });
    const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    const init = await rpc(up, initBody, {});
    expect(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    const sid = init.headers.get("mcp-session-id")!;
    const ac = new AbortController();
    const stream = await fetch(up.url, { headers: { accept: "text/event-stream", "mcp-session-id": sid }, signal: ac.signal });
    expect(stream.status).toBe(200);
    expect((await fetch(up.url, { headers: { accept: "text/event-stream", "mcp-session-id": sid } })).status).toBe(409);
    ac.abort();
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    expect((await rpc(up, list, { "mcp-session-id": sid, "mcp-protocol-version": "2099-01-01" })).status).toBe(400);
    expect((await rpc(up, list, { "mcp-session-id": sid })).status).toBe(200);
    expect((await fetch(up.url, { method: "DELETE", headers: { "mcp-session-id": sid } })).status).toBe(200);
    expect((await rpc(up, list, { "mcp-session-id": sid })).status).toBe(404);
  });

  it("OAuth: a pre-registered confidential client without DCR, revocation, a bare WWW-Authenticate", async () => {
    const preRegistered = [{ client_id: "pre", client_secret: "shh", redirect_uris: ["http://127.0.0.1:7777/cb"], token_endpoint_auth_method: "client_secret_basic" }];
    const up = await fake({ auth: { kind: "oauth", dcr: false, advertiseResourceMetadata: false, prm: "root", preRegistered } });
    const meta = (await (await fetch(`${up.oauth!.issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBeUndefined();
    expect((await fetch(`${up.oauth!.issuer}/register`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${up.origin}/.well-known/oauth-protected-resource`)).status).toBe(200);
    expect((await fetch(up.url, { method: "POST", body: "{}" })).headers.get("www-authenticate")).toBe("Bearer");

    const { access_token } = up.oauth!.issueTokens({ clientId: "pre" });
    const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    expect((await rpc(up, initBody, { authorization: `Bearer ${access_token}` })).status).toBe(200);
    const revoke = (basic: string) =>
      fetch(`${up.oauth!.issuer}/revoke`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(basic).toString("base64")}` },
        body: new URLSearchParams({ token: access_token }),
      });
    expect((await revoke("pre:wrong")).status).toBe(401);
    expect((await revoke("pre:shh")).status).toBe(200);
    expect((await rpc(up, initBody, { authorization: `Bearer ${access_token}` })).status).toBe(401);
  });
});
