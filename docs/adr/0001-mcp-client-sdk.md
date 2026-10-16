# ADR 0001: the MCP client SDK for upstream connections

Status: **accepted**, 2026-10-16 (broker M1, PR 1). Plan: [MCP-BROKER.md](../MCP-BROKER.md).

## Context

The broker is an MCP client to every upstream connection. M1 has to speak:
- 2025-era Streamable HTTP with sessions (every Hermes upstream, Notion's hosted MCP);
- the stateless **2026-07-28** revision (no `initialize`, `server/discover`, per-request `_meta`, the
  `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers, `ttlMs`, `subscriptions/listen`);
- legacy HTTP+SSE (2024-11-05) as a fallback.

It also needs OAuth with state that survives a browser redirect, refresh, cancellation from the downstream request's
abort signal, and a custom `fetch` (the pinned, SSRF-guarded one).

agentinbox pins `@modelcontextprotocol/sdk` **1.32.1** (v1), which serves `/mcp`. Its client knows protocol versions
up to 2025-11-25 only. The v2 SDK splits into `@modelcontextprotocol/client` and `@modelcontextprotocol/server`. The
latest is **2.3.1** (2026-10-05), and it negotiates both protocol generations (`versionNegotiation`).

## Decision

1. **The broker's upstream client uses `@modelcontextprotocol/client` 2.3.1, pinned exactly.** The `/mcp` server
   stays on `@modelcontextprotocol/sdk` 1.32.x. Nothing showed a need to move it: every downstream agent client
   speaks the 2025 protocol today. Moving it is an M4 question.
2. **Version negotiation is `{ mode: "auto" }`**, with the verdict cached per connection and passed back through
   `connect(transport, { prior })`.
3. **The broker owns upstream credentials.** Transports get an `AuthProvider` (`token()` plus `onUnauthorized()`),
   backed by the broker's own single-flight token manager. The SDK's `OAuthClientProvider` and `auth()` orchestrator
   aren't the refresh path, and the broker makes its own token-endpoint requests (see the evidence).

## Evidence

The fake upstream (`test/fake-mcp-upstream.ts`) and a throwaway harness ran the same scenarios on both SDKs.
`test/broker-sdk-spike.test.ts` keeps the v2 half as permanent tests, plus self-tests of the fake (37 tests, about
0.6 s, offline).

| Scenario (fake mode) | v1 1.32.1 | v2 2.3.1 |
|---|---|---|
| 2025 session server, JSON and SSE responses: connect, list, call, session id and version header on later requests | pass | pass (auto mode costs one `server/discover` → 400 probe first) |
| 2026 stateless server | **fail**: `initialize` gets 400 HeaderMismatch (-32020) | pass: `server/discover`, then `tools/list` and `tools/call`; `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers; no session |
| Dual-era server | pass, as 2025 | pass, as 2026 (2025 in the default mode) |
| 2026 `ttlMs` caching | n/a | pass: the second `listTools()` is served from cache; `cacheMode: "refresh"` refetches |
| 2026 `list_changed` | n/a | pass via `client.listen({ toolsListChanged: true })` |
| 2025 `list_changed` on the GET stream | pass | pass |
| Pagination | `listTools()` returns page 1 only | `listTools()` walks every page (capped by `listMaxPages`, default 64) |
| HTTP+SSE fallback (POST → 404 or 405) | pass: `StreamableHTTPError` with the status, then `SSEClientTransport` | pass: `SdkHttpError` (`.status` 404/405), then `SSEClientTransport` |
| Lost 2025 session (server restart) | 404 error, no auto re-init | same (`SdkHttpError`, status 404) |
| Static bearer | pass (`requestInit` headers) | pass (`AuthProvider { token }` or `requestInit`) |
| OAuth: DCR, PKCE S256, `resource` on authorize and token, same-origin and separate AS | pass | pass |
| …with every piece of state (client info, verifier, discovery state) persisted and a fresh provider finishing the flow | pass | pass |
| …every request (MCP, both metadata documents, DCR, token, and the SSE stream) through the custom `fetch` | pass | pass |
| Callback `iss` from the wrong issuer (RFC 9207) | **accepted the code** | rejected: `IssuerMismatchError` before redeeming |
| AS metadata `issuer` ≠ where it was fetched (RFC 8414 §3.3) | **accepted, redirected the user** | rejected: `IssuerMismatchError`, no redirect |
| SPA fallback (HTML 200 where metadata should be) | fails closed, untyped `SyntaxError` | same |
| Reactive refresh after expiry, one request | pass, rotated token saved | pass, rotated token saved |
| **Two requests 401 at once** (the GET stream plus a call, or two calls) | **both refresh with the same rotating token; the second reuse revokes the grant (Notion's rule); user sent back to the browser** | **same** |
| Broker-owned single-flight `AuthProvider` under the same race | not possible (transports take only `OAuthClientProvider`; it would need a fetch wrapper) | pass: one refresh, both calls succeed |
| No refresh grant (T3) / forced `invalid_grant` | `UnauthorizedError` and a redirect; `invalidateCredentials("tokens")` on invalid_grant | same |
| OAuth on plain http off loopback (forge: `http://100.104.249.49:3773`) | pass | **`InsecureTokenEndpointError`**: v2 refuses non-https token endpoints except localhost/127.0.0.1/::1 |
| `insufficient_scope` (403) | not tested | `onInsufficientScope: "throw"` → `InsufficientScopeError` (`requiredScope`) |
| Abort signal mid-call | rejects in about 50 ms; upstream gets `notifications/cancelled` | same on 2025; on 2026, rejects and the upstream sees the disconnect |
| Request timeout | `McpError` -32001 plus cancellation | `SdkError` `REQUEST_TIMEOUT` plus cancellation |

Why v2: it is the only one that reaches a 2026 server, which M1's done-when #1 requires. It also adds the RFC 9207
and RFC 8414 issuer checks the plan asks for, and an `AuthProvider` seam that a broker-owned token manager plugs into.
Staying on v1 would mean hand-writing the 2026 client: discovery, the `_meta` envelope, header mirroring including
`x-mcp-header`, the -32022 retry, `subscriptions/listen`, `resultType` and MRTR. That's the bulk of a protocol
revision, and v2 already passes it against the fake.

The two red rows in v2's column don't count against it: the double refresh fails on v1 as well, and the http token
endpoint is a v2-only refusal that the broker sidesteps by owning token requests, as it has to anyway.

## Consequences

### Costs

- Two SDK majors are installed: v1 for the server (about 4.9 MB) and v2 client plus core (about 8.2 MB). Their
  transitive dependencies (zod, jose, eventsource, pkce-challenge) are shared. tsdown leaves dependencies external,
  so `dist/cli.js` doesn't grow.
- **v1 and v2 types are not interchangeable.** Upstream code imports only from `@modelcontextprotocol/client`; native
  `/mcp` code imports only from `@modelcontextprotocol/sdk`. Tool definitions cross the boundary as plain JSON
  (they're pinned as JSON anyway).
- v2 is young (2.0.0 to 2.3.1 in a few months). It's pinned exactly and upgraded on purpose. The spike tests are the
  tripwire: the "HAZARD" test flips if the SDK ever makes refresh single-flight, and the issuer tests flip if checks
  regress.
- The license is Apache-2.0 (v1 is MIT). It's compatible with MIT; we depend on it and don't vendor it.

### For PR 2 (schema)

- Give `connections` room for the cached negotiation verdict: transport (`streamable` or `sse`), era (`legacy` or
  `modern`), the `server/discover` result for modern servers, and when it was checked. The SDK warns that a cached
  legacy verdict goes stale silently when the server upgrades, so it needs an expiry.

### For PR 3 (upstream runtime)

- **Client:** `new Client({ name, version }, { versionNegotiation: { mode: "auto" } })`, with no capabilities
  declared (no elicitation, sampling or roots, per the plan). Use one client per (connection, credential).
- **Era cache:** pass `{ prior: { kind: "legacy" } }` or `{ kind: "modern", discover }` from the connection row to
  skip the probe. Re-probe when the cached verdict fails or expires.
- **Transport fallback:** try `StreamableHTTPClientTransport` first.
  - At connect, an `SdkHttpError` with status 404 or 405 whose body isn't a modern JSON-RPC error means a legacy
    server: fall back to `SSEClientTransport` with the client in `mode: "legacy"`.
  - After connect, a 404 means the session was lost (a server restart): drop the pooled client and reconnect once.
  - Both cases carry the code `CLIENT_HTTP_NOT_IMPLEMENTED`, so check the phase and the status, not the code.
- **Pinned fetch:** pass it as `fetch` to both transports. The spike confirmed that every MCP, metadata, DCR, token and
  SSE-stream request goes through it.
  - The transports default to `redirectPolicy: "same-origin"`. Redirect handling with the pinned fetch is untested
    here; PR 3 adds the hop-by-hop tests.
  - Use `up.fetch` and `advertisedOrigin` in the fake to test tailnet and private hosts without leaving loopback.
- **Cancellation:** `callTool(params, { signal, timeout: 60_000 })`. Note that v2's second argument is the options;
  there's no result-schema argument as in v1. Abort rejects with `SdkError`, and a timeout with
  `SdkErrorCode.RequestTimeout`.
- **Static auth:** use `AuthProvider { token }` for bearer tokens and `requestInit.headers` for custom header names.
  - A bad token with an `AuthProvider` that has no `onUnauthorized` throws `UnauthorizedError`.
  - A bad token sent through `requestInit` throws `SdkHttpError` (`CLIENT_HTTP_AUTHENTICATION`, 401).
  - Map both to `needs_reauth`.
- **Strict discovery is the broker's own** (content-type, parse, issuer). The SDK only fails closed with an untyped
  `SyntaxError` on T3's HTML fallback.

### For PR 4 (OAuth)

- **Refresh is the broker's, single-flight with compare-and-swap.** This isn't a style choice: the "HAZARD" test
  shows the SDK spending a rotating refresh token twice and losing a Notion-style grant whenever two requests 401
  together. `AuthProvider.token()` returns the current token (refreshed proactively by the sweep), and
  `onUnauthorized()` joins the one in-flight refresh. On `invalid_grant` or `invalid_client`, mark `needs_reauth` and
  throw.
- **Token requests (code exchange and refresh) are the broker's, over the pinned fetch.** v2 refuses http token
  endpoints off loopback (`InsecureTokenEndpointError`), and forge needs http on its tailnet IP. The broker's rule is
  the plan's: https, or http only on the connection's admin-allowed private host.
- **Candidate v2 helpers** to reuse; each takes a `fetchFn`, so verify it doesn't impose its own transport policy:
  `registerClient` (DCR, with SEP-837 `application_type`), `startAuthorization` (PKCE S256, `resource`, scope),
  `validateAuthorizationResponseIssuer` (RFC 9207), `extractWWWAuthenticateParams` and `computeScopeUnion`.
- **Check `state` yourself** against `oauth_states`; the SDK doesn't.
- **Key stored client info and tokens by issuer** (the 2026 spec, SEP-2352). The SDK already stamps `issuer` on what it
  saves.
- **`insufficient_scope`:** use `onInsufficientScope: "throw"`, then store the scope union and mark `needs_reauth`,
  since widening a scope needs a human. The default `"reauthorize"` would start a browser flow from a background call.
- **T3 (no refresh grant):** the fake's `refreshGrant: false` reproduces it, including `grant_types_supported:
  ["authorization_code"]`. Expiry warnings come from `expires_in`. There's nothing to refresh.

### For PR 5 (catalog)

- 2026 `tools/list` results are cached by the SDK for `ttlMs`. Use `cacheMode: "refresh"` on the catalog timer, and
  set `cachePartition` to the credential if one `responseCacheStore` is shared.
- 2025 servers deliver `list_changed` through `setNotificationHandler("notifications/tools/list_changed", …)` on the
  auto-opened GET stream. 2026 servers need `client.listen({ toolsListChanged: true })`, and a re-listen when
  `subscription.closed` resolves `"remote"`.
- On 2026 connections the SDK mirrors `x-mcp-header` parameters from its cached `tools/list`, or from
  `callTool(…, { toolDefinition })`. Pass the **pinned** definition there, so a changed schema shows up as a
  HeaderMismatch rather than silently following the live one.

## Alternatives considered

- **Stay on v1 and hand-write a 2026 client.** Rejected: it's most of a protocol revision to build and maintain, and
  it would still lack the issuer checks.
- **Stay on v1 and drop 2026 from M1.** Rejected: M1 done-when #1 names a 2026 stateless server.
- **Move the server side to v2 as well.** Not needed now. `/mcp` keeps working for every 2025-era agent client, and
  moving it is a separate risk to existing users.
