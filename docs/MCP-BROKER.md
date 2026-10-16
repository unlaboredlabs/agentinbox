# MCP broker: plan

Status: **plan, not built.** Written 2026-10-16. The decisions below marked DECIDED come from Wynn. Everything else is
a recommendation until he answers the [question list](#questions-for-wynn). Research sources are linked inline. The
code map refers to main at e2fe0c5.

## Goal

agentinbox grows from a Gmail/Calendar broker into an **MCP broker**:

- **One endpoint per agent.** It unifies all of that agent's MCP servers.
- **Pre-made integrations**, starting with **Notion** and **WHOOP**. Gmail and Calendar stay as the built-in native
  integration.
- **The broker holds every upstream credential.** Agents never see them.
- **Each agent gets only the tools it's allowed.**
- **Existing machinery is reused:** approvals, the audit log, signed webhooks and the listener relay.

Why: today Hermes has 7 separate MCP entries (agentinbox, whoop, brightspace, hearloom, 3× T3). Each has its own auth,
timeouts and re-login dance: 30-day OAuth with no refresh, and a 401 re-auth by hand. None of them share audit or
approvals.

### DECIDED (Wynn, 2026-10-16)

1. **Rename: yes, now.** The name is pending; the candidates are patchbay, tooldock, gatehouse and agentvault. Plan
   the rename (the npm package and bin, the repo, console branding, and a migration path for existing
   `agentinbox-cli` installs). Execute it only once the name is final. See [Rename](#rename).
2. **A public product for anyone from day one,** not just Wynn and Hermes. Multi-user setup, the integrations' own
   OAuth apps and self-serve setup through the CLI and console are milestone-1 concerns.
3. **WHOOP is a native integration on the WHOOP API.** Anyone connects their own account. It does not go through
   Wynn's whoop.weish.me dashboard.
4. **Hermes dogfoods it.** Once milestone 1 works, Hermes moves its MCPs onto the broker endpoint. Milestone 1
   therefore covers remote HTTP upstreams with OAuth (like the T3 servers) and with bearer tokens.

## Architecture

```
agent (Claude Code, Codex, Cursor, Hermes, any MCP client)
   │  one endpoint: POST /mcp, Authorization: Bearer aib_… (per agent, as today)
   ▼
broker ──── policy (grants: native + per-tool) ── approvals ── audit ── events/webhooks/listen
   │
   ├── native: Gmail, Calendar (unchanged tool names)
   ├── native: WHOOP (WHOOP API v2)
   └── upstream connections (MCP client pool)
         ├── remote Streamable HTTP / legacy HTTP+SSE  (auth: none | static header | OAuth)
         └── local stdio (admin-only, pinned command, env-injected secrets)
```

### Connections (upstreams)

A **connection** is one upstream with its credential. It has:
- a kind: `native_google` (today's accounts), `native_whoop`, `remote_http` or `stdio`;
- an operator-chosen **slug** (`notion`, `t3-forge`, …);
- a status: `active`, `needs_reauth`, `error` or `disabled`;
- a cached, pinned tool catalog.

**Remote HTTP upstreams.** The broker is an MCP client to them, following the spec's authorization rules
([spec auth](https://modelcontextprotocol.io/specification/draft/basic/authorization)):

- **Discovery.**
  - On a 401, read `resource_metadata` from `WWW-Authenticate`. Otherwise fall back to
    `/.well-known/oauth-protected-resource`, per RFC 9728.
  - Then fetch the authorization server's metadata (RFC 8414, with OIDC as a fallback), with an exact issuer check.
  - Refuse an authorization server that doesn't advertise PKCE S256.
- **Client registration, in this order:**
  1. a pre-registered client (a preset ships the client ID, or the user pastes it);
  2. a Client ID Metadata Document, when the install has a public https URL to host it;
  3. Dynamic Client Registration (deprecated in 2026-07-28, but what Notion's hosted MCP offers today);
  4. ask the user.

  Registrations are stored per issuer and never re-registered casually: Notion says re-registering orphans the
  earlier grants ([Notion](https://developers.notion.com/guides/mcp/build-mcp-client.md)).
- **The authorization flow.**
  - PKCE S256, `state` checked by us (the TS SDK doesn't), `iss` checked (RFC 9207).
  - `resource` (RFC 8707) is sent on both the authorize and token requests.
  - `offline_access` is requested whenever the server advertises it.
  - It reuses today's Google machinery: the `oauth_states` table, the popup and `BroadcastChannel` callback page,
    and the direct-vs-paste callback mode. The callback lives on a new path, `/oauth/connections/callback`, so
    Google's registered redirect URI never changes.
- **Tokens.** An SQLite-backed `OAuthClientProvider`, encrypted with the existing AES-GCM `Crypto`. Refresh follows
  today's `TokenManager`: one refresh in flight per connection, and a compare-and-swap on the rotated refresh token,
  which is saved before it's used. On top of that:
  - **Proactive refresh:** at `expires_at` minus max(60 s, 10 % of the lifetime). A background sweep keeps idle
    connections from losing rotating refresh tokens; the SDK only refreshes on a 401.
  - **Reactive refresh:** on a 401, refresh once and retry once. On `invalid_grant` or `invalid_client`, mark
    `needs_reauth`, emit `connection.auth_failed` (mirroring `account.auth_failed`), and stop retrying.
  - **No refresh token, or a hard cap** (Notion's hosted MCP: 8 h access tokens, rotating refresh tokens, a 180-day
    cap and a 30-day idle limit): show "expires in N days" at 7 days and 1 day, and send the same events. Nobody
    finds out from a 401 in the middle of a task.
  - **`insufficient_scope`:** store the union of the scopes, then mark `needs_reauth` with the reason. Widening a
    scope always needs a human.
  - **While a connection needs re-auth:** its tools stay listed, and calls return `isError`: "the owner must
    reconnect *Notion* in agentinbox (Connections → Reconnect)".
- **Static header auth** (bearer or API key): stored encrypted, injected per request, never logged.
- **Transports.** It talks to both protocol generations. The 2026-07-28 revision is stateless: it removed
  `initialize`, `Mcp-Session-Id` and server-initiated requests, and deprecated DCR, sampling, roots and logging
  ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). 2025-era servers keep pooled
  sessions per (connection, credential), and HTTP+SSE is a fallback. Each call has a 60 s timeout, and cancellation
  propagates from the downstream request's abort signal.
- **Outbound fetch is pinned and SSRF-guarded.** It reuses the webhook guard `resolveTarget`, through an undici
  `Agent` whose `lookup` is pinned. It applies to the upstream URL and to every discovered OAuth URL, with redirects
  re-checked hop by hop (CVE-2025-6514 was an `authorization_endpoint` RCE,
  [NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-6514)). Loopback and private hosts need an explicit allowlist entry,
  because local MCP servers are a legitimate case.

**stdio upstreams.** Only the console admin can add one, and the console shows the full command, arguments and
environment keys, untruncated.
- Pinned package versions are required: no `@latest`.
- Spawn uses `shell: false` with a minimal `env` (PATH plus the configured secrets). It never inherits
  `process.env`, which may hold the master key, and `cwd` is outside the data directory.
- Lifecycle: close stdin, wait, SIGTERM, then SIGKILL. The process is restarted with backoff if it dies.
- Changing the command makes it a new connection, which needs a new review.

**Upstream client capabilities in v1:** none. Elicitation, sampling and roots are not declared, so upstreams can't
ask for them. Resources and prompts aren't proxied in v1.

### Tools: namespacing, catalog, pinning

- **Names.**
  - Upstream tools are exposed as `<slug>__<tool>`, using only `[A-Za-z0-9_-]`.
  - The broker-side name is at most 64 characters, because Claude Code prepends `mcp__<server>__` and drops anything
    over 128 ([Claude Code](https://code.claude.com/docs/en/mcp)).
  - No dots: Copilot CLI rejects them, and agentinbox's own "no dot = tool call" audit query relies on it.
  - The operator chooses the slug; the upstream never does.
  - **Native tools keep their current unprefixed names,** so existing agents, Hermes routes and SKILL.md keep
    working. Slugs that collide with native names or each other are refused.
- **Catalog.** `tools/list` is fetched with pagination when the connection is made, again when the TTL the server
  gives (`ttlMs`) expires, on a timer, and on `list_changed` for 2025-era sessions. It's cached per
  (connection, credential).
- **Pinning (rug-pull defence).** Each tool's hash is `sha256(JCS({name, title, description, inputSchema,
  outputSchema, annotations}))`, and the server's `instructions` are hashed separately.
  - A tool goes to agents only once its current hash is approved.
  - A new or changed hash moves the tool to `pending_review`: it's hidden, and calls fail with `tool_changed`. The
    console shows a diff to re-approve.
  - Agents always receive the **approved snapshot**, never the live definition. Arguments are validated against the
    pinned `inputSchema` (ajv) before they're forwarded.
  - Precedents: [mcp-context-protector](https://github.com/trailofbits/mcp-context-protector),
    [Invariant on rug pulls](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks).
- **Descriptions shown to agents** are cleaned and capped: ANSI escapes, tag characters, zero-width and bidi
  characters are stripped, about 1 KB per tool and 256 characters per parameter. At review time the console flags
  suspicious signs without blocking them: `<IMPORTANT>`, "don't tell the user", file paths, other servers' tool
  names, catch-all parameters (`context`, `sidenote`) and base64 blobs. The operator may override a description.
- **Bulk review.** After a connection is made, the console lists all its tools grouped as read, write or destructive,
  with "Approve all read tools" and per-tool toggles. Reviewing 60 Notion tools takes one screen, not 60 clicks.

### Per-agent scopes (grants)

Native grants stay exactly as they are, keyed by agent × Google account. A new **tool grant** is keyed by agent ×
connection, and gives each tool a mode:

- `allow`
- `approval`: the broker holds the call until a human approves it
- `deny`

Defaults, consistent with "a new agent can do nothing":

| Tool class | Default mode |
|---|---|
| New or unknown tool | deny until reviewed |
| Read | allow |
| Write | approval |
| Destructive or egress | approval, or deny for deletes |

**Classifying tools.** A tool's class is, in order of priority: the operator's override, then a heuristic on its name
(`send|post|create|update|delete|share|publish|invite|exec|run|fetch`), then its annotations. Annotations may only
**raise** risk. `destructiveHint: true` and `openWorldHint: true` count, but `readOnlyHint` from an unreviewed server
is ignored: the spec says clients MUST treat annotations as untrusted
([tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).

**Other parts of a tool grant:**
- **Argument constraints,** optional per tool, generalising `allowTo`. For example `notion__create_pages` where
  `parent.page_id ∈ {…}`.
- **Caps** per tool and per class, generalising `reserveSend`. They count queued and uncertain calls.
- **A per-agent daily egress byte budget,** which catches drip exfiltration spread over many small calls.

**Lethal-trifecta banner** ([Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)). Each approved tool
carries three flags:
- `private`: it reads the user's data;
- `untrusted`: it returns content third parties can write;
- `egress`: it can send data out.

The grant editor takes the union across all of an agent's connections. When one agent has all three, it shows a red
banner naming the tools behind each, with two fixes: "set egress tools to approval" or "split into a reader and an
actor".

### Approvals for risky tools

A new approval kind, `mcp.call`:
- **When the call is queued:** validate it, canonicalise the arguments, and store their bytes with their sha256, the
  tool's pinned hash and an expiry.
- **The console card shows exactly those bytes.** Recipients and URLs are pulled to the top, then the
  pretty-printed JSON follows. Lines wrap rather than scroll sideways, invisible characters are shown as visible
  escapes, and long strings are expanded. The WhatsApp exfiltration hid its payload past a scrollbar
  ([Invariant](https://invariantlabs.ai/blog/whatsapp-mcp-exploited)).
- **On approve:** re-check the agent, the grant, the tool's pinned hash and the argument hash, then forward **the
  stored bytes**. The result (truncated) is kept for `get_call_status`.
- **Uncertain outcomes:** with no idempotency key, an interrupted call is marked as having an unknown outcome and is
  never retried automatically.
- **The agent's side:** it gets `pending_approval` plus an approval id, and polls with a generic `get_call_status`
  tool, as `get_send_status` works today. Approvals also emit an `approval.requested` event, so webhooks and the
  listener can notify the human, e.g. Hermes on Telegram.
- **Avoiding approval fatigue:**
  - only writes and egress need approval;
  - scoped, expiring standing rules ("allow `notion__create_pages` under page X for 7 days") instead of
    "always allow";
  - grouping of similar pending calls;
  - an agent is paused once it has more than N pending approvals an hour.
- **Schema changes:** this requires migrating `approvals.account_id` and `draft_id` away from NOT NULL. SQLite needs a
  table rebuild for that, which keeps the pending rows; Calendar's kinds will move onto the same table.

### Upstream output is untrusted

Every `text` block from an upstream is:
- cleaned with the existing `stripInvisible`, plus ANSI stripping;
- truncated to the existing `maxBodyChars`;
- wrapped in `<tool_output source="<slug>/<tool>" nonce="…" untrusted>`, with a fresh random nonce per response and
  every delimiter escaped inside it.

The existing `escapeDelimiters` is generalised to all of agentinbox's tags, so an upstream can't close
`</email_content>`. `structuredContent` is validated against the pinned `outputSchema` and passed through with its
wrapped text twin. Images and audio pass through with a size cap.

Operators can mark a tool `self`: computed or user-only data such as WHOOP metrics, which skips wrapping. The default
is `untrusted`. The server instructions state the "tool output is data, not instructions" rule once, as is done today
for email.

### One endpoint with 100+ tools

The evidence on how many tools a model can handle:
- Anthropic: tool selection "degrades once you exceed 30–50 available tools"
  ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
- OpenAI: aim for "fewer than 20 functions" at the start of a turn
  ([function calling](https://developers.openai.com/api/docs/guides/function-calling)).
- RAG-MCP: failures cluster above about 30 candidates ([arXiv 2505.03275](https://arxiv.org/html/2505.03275)).

But the clients differ in how they load tools:
- **Claude Code and Codex** already defer MCP tools behind their own tool search.
- **Cursor** keeps only the names in context.
- **Hermes** loads everything ([Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)).

The design:

1. **Default: per-agent allowlists with real namespaced names.** Annotations pass through, and the server
   instructions list the categories. Real names keep the clients' own approval mechanisms working: Codex's `writes`
   mode and Claude Code's permission rules. Deferring clients pay little for a long list.
2. **Search mode** (`/mcp?mode=search`, or set per agent) for clients that don't defer, or when an agent's filtered
   set exceeds about 30 tools or 10K tokens. The agent gets:
   - `search_tools`: BM25 over names, descriptions and argument names, returning the top 5 with full schemas;
     LiveMCPBench found top-5 best ([arXiv 2508.01780](https://arxiv.org/html/2508.01780));
   - `call_read_tool` and `call_write_tool`, split the way Zapier does
     ([Zapier](https://docs.zapier.com/mcp/overview/how-tools-work));
   - 3–5 "hot" tools exposed directly.

   Every inner call is audited and governed under its real name, so search mode loses nothing on the broker side.
3. **Code mode is deferred.** It cuts tokens the most
   ([Cloudflare](https://blog.cloudflare.com/enterprise-mcp/),
   [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)), but it needs a sandbox and hides each
   inner call from approvals.
4. **Toolset groups are configuration only.** Turning groups on at runtime through `list_changed` breaks Codex, which
   ignores it ([codex#37417](https://github.com/openai/codex/issues/37417)).

### Agents' own auth

The agent-side `aib_` keys stay. Claude Code, Codex, Cursor and Hermes all support static headers for remote MCP
servers ([Claude Code](https://code.claude.com/docs/en/mcp), [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Cursor](https://cursor.com/docs/context/mcp), [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)).
Making agentinbox an OAuth authorization server for agents is deferred. It would bring audience validation,
per-client consent and the confused-deputy rules with it. Upstream tokens never go to agents, and `aib_` keys never go
upstream: the spec forbids token passthrough.

### Events from integrations

The events outbox, webhooks, SSE stream and listener relay are generalised:
- Event types become open-ended under a prefix: `whoop.recovery_updated` and `connection.auth_failed`, next to today's
  closed mail and calendar enum.
- Events carry `connection_id` where they used to carry `account_id`.
- `canSeeEvent` gains a branch for tool grants.
- A listener stream for an agent without Gmail access must work. Today the stream refuses it with `no_read_grant`.

## Pre-made integrations

### Notion: proxy the hosted MCP, with a native fallback

| | Hosted MCP (`mcp.notion.com/mcp`) | Archived OSS server + internal token | Native REST tools |
|---|---|---|---|
| User steps | **2**: Connect, then approve and pick a workspace | 4, and only a workspace owner can create the token | 4–5 |
| Access | Everything the user can see in the workspace (the broker filters per tool) | Per page | Per page |
| Credential | 8 h access token, rotating refresh token, reconnect within 180 days and after 30 idle days | Never expires | Never expires (internal token) |
| Tools | About 60, maintained by Notion, markdown output, labelled read/write | 24, raw JSON; officially no longer maintained | Whatever we write |
| Maintenance for us | Refresh logic only | Package deprecated | High: the API changes often |

Sources: [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp),
[build-mcp-client](https://developers.notion.com/guides/mcp/build-mcp-client.md),
[tools](https://developers.notion.com/guides/mcp/mcp-supported-tools),
[notion-mcp-server](https://github.com/makenotion/notion-mcp-server).

**Recommendation: the hosted MCP through DCR.** It advertises DCR and Client ID Metadata Documents with public
clients (`token_endpoint_auth_methods_supported` includes `none`), so **no install registers an app**. That makes a
public product possible without a shared secret.

**Preset contents:**
- the URL;
- slug `notion`;
- read/write classes taken from Notion's own labels;
- deletes and the agent-session tools denied by default;
- a "Reconnect before day 180" warning.

**Fallback,** for people who need per-page access or whose Enterprise workspace blocks MCP clients: a small native
REST tool set on an internal token. It goes later, and only if asked for.

### WHOOP: native, each user's own app

The official v2 API ([WHOOP API](https://developer.whoop.com/api/), [OAuth](https://developer.whoop.com/docs/developing/oauth)):
- **Scopes:** `read:recovery|cycles|workout|sleep|profile|body_measurement`, plus `offline` for a refresh token.
- **Tokens:** 1 h access tokens. Refresh tokens rotate and are single-use. Refreshing needs the client secret, and
  there's no PKCE.
- **Rate limit:** 100 requests a minute and 10,000 a day.
- **Webhooks:** `recovery|sleep|workout.updated|deleted`, HMAC-SHA256 signed with the client secret.

**A shared project app can't work** ([app approval](https://developer.whoop.com/docs/developing/app-approval)):
- the client secret is needed for the token exchange, refresh and webhook verification, and can't ship in open source;
- Sandbox caps an app at 10 members;
- an app has one fixed webhook URL;
- redirect URIs must match exactly.

So **each user registers their own app** (within Sandbox's 10 members, no review). The console guides it in 5 steps:
1. open the developer dashboard (deep link);
2. create a team;
3. create an app: the wizard shows the scopes to tick, a copy button for the redirect URI, and the webhook URL when
   there's a public https URL;
4. paste the client ID and secret, which are checked live;
5. Connect and approve.

There's no 30-day wall: one refresh worker per connection keeps the token alive indefinitely and saves each rotated
refresh token atomically. Wynn's current 30-day re-login most likely comes from his dashboard's own MCP bearer, not
from WHOOP.

**Tools, all reads, so no approvals:**
- `whoop__get_recovery`
- `whoop__get_sleep`
- `whoop__get_cycles`
- `whoop__get_workouts`
- `whoop__get_profile`
- `whoop__get_body`
- `whoop__get_today`: the most useful one; a summary of today's recovery, last night's sleep, strain and HRV

All take date ranges and handle pagination, and output is compact text plus `structuredContent`.

**Events:** `whoop.recovery_updated` (and sleep and workout) go through the existing outbox, webhooks and listener.
Push comes from WHOOP webhooks when there's a public https URL, with dedupe on `trace_id` and a reconciliation poll.
Otherwise a poll every 15 minutes (well within 10,000 requests a day). This gives a "morning recovery is in" trigger
for Hermes.

One thing to verify at build time: whether WHOOP accepts an `http://localhost` redirect. Guides disagree. The fallback
is an https public URL, or paste mode with `https://localhost`.

## Setup UX (no external docs)

The bar: the CLI wizard and console guide every step end to end, with deep links and copy buttons.

- **First run, with Google optional (recommended).** The current wizard requires Google Cloud before anything else.
  A public broker needs a first step that asks what to connect: Notion, WHOOP, a custom MCP server, or Gmail and
  Calendar (which take today's eight-step Google path). Someone who only wants Notion and WHOOP is done in a few
  minutes.
- **Add connection** (console, Connections page):
  - **Presets** (Notion, WHOOP, Google) run their own guided flows.
  - **Custom:** paste a URL. The broker probes it and shows what it found ("OAuth via auth.example.com, supports
    automatic registration", or "needs an API key"), then shows the right button or field. stdio: an admin form with
    a command preview and the version-pinning check.
  - Then: **review tools** (bulk approve reads), **pick agents** (grant modes per tool), done.
- **Import from a client config, for Hermes dogfooding and migrations.**
  - `npx agentinbox-cli import --from hermes` (also `claude-code`, `cursor`, `codex`) reads that client's MCP config.
    For Hermes that's `~/.hermes/config.yaml` `mcp_servers`.
  - It creates one connection per server, moving the credentials into the broker. OAuth ones get a "Reconnect"
    button, because their tokens live in the client.
  - Then `setup-mcp --tool hermes` replaces the separate entries with the single broker entry, keeping a backup.
  - A dry run comes first and prints exactly what will change.
- **CLI.** `npx agentinbox-cli connections add notion|whoop|<url>` runs interactively in the terminal: it opens the
  browser for OAuth (or uses paste mode over SSH) and asks the review questions. `connections list|reconnect|disable`.
  Writing the broker's database needs the admin, so the CLI talks to the local daemon's admin API with a one-time
  local token.
- **Every failure names its fix in the UI:** `needs_reauth` → Reconnect, an expiring cap → a dated reminder, a 429 →
  retry-after, an SSRF block → "allow this host in Settings".

## Existing gateways: what to borrow, what to avoid

Teardown from primary sources (READMEs, docs, source), as of 2026-10-16.

| Project | Naming | Upstream credentials | Per-client scoping | Policy / human in the loop | Large tool lists |
|---|---|---|---|---|---|
| [Docker mcp-gateway](https://github.com/docker/mcp-gateway) | Unprefixed with collision checks (case-folded, reserved names); prefix opt-in | Keychain or credential helper; background OAuth refresh with retries | Profiles with `server.tool` allowlists | `before:exec` interceptor | `mcp-find`/`mcp-add` (agents add servers to themselves), code mode |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) | `{gateway}-{tool}` | OAuth code and client-credentials flows, encrypted at rest, RFC 8707 `resource` with an omit switch | Virtual servers, teams, RBAC | 40+ plugins; no approval plugin | Lookup cache only |
| [MetaMCP](https://github.com/metatool-ai/metamcp) | `server__tool` | Bearer, or an OAuth sessions table | Namespaces mapped to endpoints, overrides | Middleware | None |
| [1mcp](https://github.com/1mcp-app/agent) | `server_1mcp_tool` | OAuth dashboard | Tags and presets (tags double as scopes) | None | Lazy `tool_list`/`tool_schema`/`tool_invoke` |
| [agentgateway](https://agentgateway.dev/docs/standalone/latest/documentation/mcp/spec-compatibility/) | `target_tool` | Backend auth, token exchange (RFC 8693) | CEL rules on tool name and claims; denied tools filtered from lists | ExtMCP pass, mutate or deny | None; translates between protocol versions |
| [ToolHive vMCP](https://github.com/stacklok/toolhive) | Conflict strategies | Token exchange, encrypted secrets | Filtering, description overrides | Elicitation steps in workflows | `find_tool`/`call_tool` over SQLite FTS5 (session-bound, so clients fall back to the 2025 protocol) |
| [Obot](https://github.com/obot-platform/obot) | Composite servers | OAuth on the user's behalf | Catalog access policies | Filter webhooks (HMAC-signed) that reject or mutate | Catalog search |
| [MCPJungle](https://github.com/mcpjungle/MCPJungle) | `server__tool` | No upstream OAuth | Deny-by-default client allowlist, tool groups | None | Tool groups |
| [Lasso](https://github.com/lasso-security/mcp-gateway) | Two meta-tools only | Env passthrough | None | Secret and PII masking; description scan at load only | Meta-tools |
| [TBXark mcp-proxy](https://github.com/TBXark/mcp-proxy) | Per-server path | Auth-code OAuth with refresh; persists the registered client ID | Allow/block filters | None | None |

Also reviewed: Microsoft mcp-gateway (Kubernetes and Entra only), Agent Router (formerly Envoy AI Gateway), Unla,
sparfenyuk mcp-proxy. mcp-router reached end of life on 2026-09-18.

**Borrowed:**
- `server__tool` naming with Docker's collision checks, re-run on every reload;
- deny by default, with ungranted tools removed from `tools/list` **and** enforced on every call path, including
  search mode (Docker treats a bypass as a vulnerability);
- FTS5-backed search meta-tools that stay stateless and grant-scoped (ToolHive's session-bound version forces clients
  back to the 2025 protocol);
- an encrypted OAuth store that **persists the registered client ID** (TBXark: losing it makes every refresh fail
  silently), refreshes in the background with backoff, and lets `resource` be omitted per connection;
- denials returned as `isError` tool results;
- the SSRF guard on upstream URLs;
- secret scanning of arguments and results on by default, and logging the shape of the arguments rather than their
  values for reads (Docker);
- debounced `list_changed` handling.

**Avoided:**
- enterprise sprawl (ContextForge needs Postgres and Redis; Microsoft's gateway needs Kubernetes);
- **agents adding servers to themselves** (Docker's `mcp-add`): only the human adds connections;
- forwarding the agent's own `Authorization` header upstream;
- approvals that depend on client elicitation (60 s timeouts, and MRTR changes the mechanism);
- REST-to-MCP conversion, LLM routing and A2A, which are out of scope;
- depending on single-maintainer or end-of-life projects.

**Gaps none of them fill, which agentinbox's existing strengths cover:**
- durable human approvals with exact arguments;
- signed webhooks for tool calls and approval decisions;
- relaying upstream domain events to agents through the listener;
- argument-level grants without an external policy server;
- tool-definition pinning with re-review on drift.

That last one isn't documented by any project reviewed (the teardown's code search was cut short by a rate limit, so
treat it as "not documented" rather than proven absent).

**Hosted platforms** (Composio, Pipedream Connect, Klavis Strata, Smithery, Cloudflare MCP Portals, Zapier, Arcade,
Merge) all converge on the same patterns:
- credentials held by the platform and keyed by a user;
- an auth failure answered with **a connect URL inside the tool result** (Pipedream, Smithery, Klavis, Zapier);
- per-session or per-agent allowlists;
- search-first meta-tools for large catalogs.

**Borrowed:**
- the connect-URL-in-`isError` pattern;
- Zapier's read/write split of the execute tools;
- Klavis's progressive discovery (the top-5-with-schemas variant);
- Cloudflare's per-portal tool curation and URL-selected mode.

**Avoided:**
- approvals that depend on client elicitation (Composio's needs clients that support it, and Hermes declines URL-mode
  elicitation);
- runtime toolset enablement through `list_changed`;
- one shared hosted OAuth app (impossible here for WHOOP; unnecessary for Notion).

Only Composio documents per-call human approval, so agentinbox's approvals with exact arguments are a real
differentiator.

Sources: [Composio](https://docs.composio.dev/kb/guide/mcp-tool-router-sessions),
[Pipedream](https://pipedream.com/docs/connect/mcp/developers), [Klavis](https://www.klavis.ai/docs/concepts/strata),
[Smithery](https://smithery.ai/docs/use/connect), [Cloudflare](https://developers.cloudflare.com/changelog/post/2025-08-26-mcp-server-portals/),
[Zapier](https://docs.zapier.com/mcp/overview/how-tools-work), [Arcade](https://docs.arcade.dev/en/guides/mcp-gateways),
[Merge](https://docs.merge.dev/merge-agent-handler/how-it-works).

## Security model

Detection can't be relied on. In MCPTox, tool poisoning succeeded 36.5 % of the time on average across 20 model
setups, and no model refused more than 3 % of attacks ([arXiv 2508.14925](https://arxiv.org/abs/2508.14925)). So the
controls are enforced in code, on the action side, as agentinbox already does for mail
([OWASP LLM06](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)).

| Threat | Real example | Mitigation | When |
|---|---|---|---|
| Injection flowing across tools (untrusted output driving a write elsewhere) | GitHub MCP toxic flow ([Invariant](https://invariantlabs.ai/blog/mcp-github-vulnerability)); WhatsApp JSON breakout | Nonce-wrapped untrusted output; provenance flags; trifecta banner; writes and egress to approval by default | v1 |
| | | Session taint: after untrusted output, egress calls escalate to approval for N minutes (CaMeL-style; [arXiv 2503.18813](https://arxiv.org/abs/2503.18813), [design patterns](https://arxiv.org/abs/2506.08837)) | later |
| Tool poisoning and rug pulls | `<IMPORTANT>` `add` tool reading `~/.ssh` ([Invariant](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks)); [line jumping](https://blog.trailofbits.com/2025/04/21/jumping-the-line-how-mcp-servers-can-attack-you-before-you-ever-use-them/); postmark-mcp 1.0.16 BCC'ing all mail ([BleepingComputer](https://www.bleepingcomputer.com/news/security/unofficial-postmark-mcp-npm-silently-stole-users-emails/)) | Hash pinning, review on change, serving the pinned snapshot, cleaned descriptions, review-time signals, pinned stdio versions | v1 |
| Cross-server shadowing | A description rewriting another server's `send_email` | Operator-chosen slugs, collision checks, flagging descriptions that name other servers' tools, per-agent grants | v1 |
| Token exfiltration and confused deputy | Token passthrough and SSRF ([MCP security](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)); CVE-2025-6514 | No passthrough; encrypted per-connection credentials; scrubbing of exact token strings and `Bearer …` from results and errors; one pinned, guarded fetch; https only for authorization URLs | v1 |
| stdio as a code-execution surface | Spec "local MCP server compromise" | Admin-only; full command shown; pinned versions; `shell: false`; minimal env; no `process.env` inheritance | v1 |
| | | bubblewrap or `systemd-run` sandbox, network namespace | later |
| Approval bypass | Arguments hidden past a scrollbar; "always allow" fatigue; lying annotations | Exact-bytes approvals with hash re-check; annotations can only raise risk; scoped expiring rules; caps and an egress byte budget against split calls | v1 |
| | | Near-duplicate egress detection | later |
| Incident response | Postmark victims couldn't tell what was sent | Audit per call: agent, connection, tool, pinned hash, decision, args hash and size, result size, signals, duration. Full arguments kept only for writes and egress, with secrets redacted. One-click kill per connection (disable, cancel pending, kill the process, RFC 7009 revoke, delete the credential). An incident view per connection and time window | v1 |
| | | Hash-chained audit rows | later |

**Out of scope, stated plainly in the docs:** a malicious upstream can still misuse data **inside its own service**,
as postmark-mcp did, and a stdio server's own network access can't be controlled without a sandbox. The broker limits
what reaches an upstream, and who can call it. It doesn't vouch for the upstream.

## Code impact (from the code map)

**Reused as is:**
- the stateless per-request `buildMcpServer` with its `register()` audit and error wrapper;
- `auditRejections`, `AuditLog`, `Crypto`;
- the OAuth pieces: PKCE, `oauth_states`, the callback page and `callbackMode`;
- the token refresh pattern: single-flight with compare-and-swap, `needs_reauth`;
- the `Approvals` state machine;
- the events outbox with webhooks, SSE and the listener;
- `resolveTarget`;
- `stripInvisible`, `wrapUntrusted`, `truncateText`;
- the console's OAuth popup host and dialog-host patterns.

**Forced refactors (each one a milestone item):**
1. A `connections` table, with Google as a native kind. The `accounts` table stays and is linked to it.
2. `tool_grants` beside the native `grants`, plus a `decideTool()` in policy.
3. Rebuilding the approvals table: `account_id` and `draft_id` become nullable, and a generic payload is added.
4. Opening the closed enums: `TOOL_NAMES`, `EVENT_TYPES`, `ApprovalKind`, `UntrustedTag`, `describeError`.
5. An upstream client runtime: the SDK client pool, stdio supervision, the catalog cache and the pinned fetch.

**SDK:** agentinbox pins `@modelcontextprotocol/sdk ^1.32`. The 2026-07-28 version negotiation (`versionNegotiation:
'auto'`) and the gateway guide are documented for the v2 `@modelcontextprotocol/client` package
([protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md),
[gateway](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/gateway.md)). Milestone 1
starts with a one-day spike to decide whether to move to v2.

**Risks to existing users:**
- native tool names and SKILL.md must not change;
- the "no dot = tool call" queries (Overview counts, `anyAgentVerified`, send caps) must keep working;
- the migrations must keep pending approvals and cascades;
- the `/oauth/callback` path and Google's redirect URI must not change;
- the `/mcp` body limits stay as they are.

## Milestones

Each milestone is one merge train: tier L (two reviewers plus a security review) where it touches auth, credentials,
grants or migrations. It ships as a nightly and is done when every item under "Done when" holds.

### M0: Rename (as soon as the name is final)

**Scope:** see [Rename](#rename). It goes first so that every later migration and doc uses the final name.

**Done when:**
- the new package publishes nightlies;
- an existing install (Wynn's: nightly, 2 accounts, Pub/Sub, a Hermes listener) upgrades with one command and loses no
  mail;
- the old `agentinbox-cli` prints the move and keeps working;
- the repo, README, console and CLI all carry the new name.

### M1: Broker core (smallest useful)

**Scope:**
- the SDK spike;
- the `connections` model;
- remote HTTP upstreams (Streamable HTTP in both generations, plus SSE) with auth none, static header or OAuth
  (pre-registered, DCR, or a metadata document), proactive refresh and `needs_reauth`;
- the pinned SSRF-guarded fetch;
- catalog, pinning and review;
- `<slug>__<tool>` namespacing;
- tool grants with allow, approval or deny;
- `mcp.call` approvals with exact arguments;
- untrusted output wrapping and token scrubbing;
- the audit fields;
- the one-click kill;
- `connection.auth_failed` events and a listener stream for agents without Gmail;
- console: Connections, Add connection (custom URL plus the **Notion preset**), the tool review screen, the tool grant
  editor, the approval card, and first run with Google optional;
- CLI: `connections add|list|reconnect|disable` and `import --from hermes|claude-code|cursor|codex`;
- docs and SKILL.md.

stdio is in M1 only if Hermes's brightspace or hearloom server needs it (see question 3).

**Done when:**
1. An E2E test against fake upstream MCP servers covers:
   - OAuth with DCR and refresh rotation;
   - a 401 refresh followed by `needs_reauth`;
   - a bearer server;
   - a 2025 session server and a 2026 stateless server;
   - a changed tool landing in `pending_review`;
   - an approval forwarding the exact bytes;
   - an SSRF block;
   - native Gmail and Calendar tools unchanged.
2. Notion connects through the preset on a real workspace, and an agent reads and writes, with the write approved.
3. Hermes on Wynn's install has **one** MCP entry, the broker, serving agentinbox plus the T3 servers and the others.
4. One fresh-persona walk passes: a new user with Notion only, no Google.

### M2: WHOOP native

**Scope:** the guided per-user app setup, the WHOOP tools, the refresh worker, webhooks or polling, and the
`whoop.*` events.

**Done when:**
- an E2E test against a fake WHOOP covers OAuth, refresh rotation, the webhook signature, polling and the events;
- a real WHOOP account connects and `whoop__get_today` returns data;
- a listener receives `whoop.recovery_updated`;
- one persona walk of WHOOP setup passes;
- Hermes's old `whoop` entry is removed.

### M3: Search mode for big toolsets

**Scope:** `?mode=search` and the per-agent setting: `search_tools` (top 5 with schemas), `call_read_tool` and
`call_write_tool`, hot tools, auditing under real names, and an automatic suggestion above about 30 tools.

**Done when:**
- an eval on a 100-tool fake catalog picks the right tool at least as often as listing every tool;
- Hermes runs in search mode with every tool reachable;
- approvals still hold for calls made through `call_write_tool`.

### M4: Hardening and the rest (each item ships alone)

- session taint (egress escalates to approval after untrusted reads);
- the stdio sandbox (if stdio shipped);
- near-duplicate egress detection;
- hash-chained audit rows;
- resources and prompts passthrough;
- URL-mode elicitation shown as approval cards;
- the native Notion REST fallback;
- more presets (GitHub, Linear, Slack: only proxies of their hosted MCPs, no native code);
- multi-user (see question 1).

## Rename

Planned now and executed when the name is final. `<new>` stands for the chosen name.

- **npm:** publish `<new>` (or `<new>-cli` if the bare name is taken; check it first) with a `bin` of `<new>`. Keep
  the `agentinbox` bin as an alias for a release cycle.
- **The old package:** publish one last `agentinbox-cli` major, a shim that depends on `<new>`, prints "agentinbox is
  now <new>: run `npx <new> …`", then runs it. Then `npm deprecate agentinbox-cli` with the same message. The nightly
  workflow moves to the new package, which needs a trusted publisher registered for it.
- **The repo:** GitHub rename `wynn-dev/agentinbox` → `wynn-dev/<new>`. Old URLs redirect; update the badges and
  links.
- **The data directory:** new installs use `~/.<new>`. If `~/.<new>` doesn't exist and `~/.agentinbox` does, keep
  using `~/.agentinbox` and say so once. Moving it automatically is a risk to `master.key` and isn't worth taking.
- **Environment variables:** read `<NEW>_*` first, then `AGENTINBOX_*` (MASTER_KEY, DATA, GOOGLE_* bases).
- **Agent keys:** existing `aib_` keys stay valid forever. Whether new keys get a new prefix is question 7.
- **Services:** `service install` on the new name detects the old launchd label (`com.unlaboredlabs.agentinbox*`) or
  systemd unit, boots it out (waiting for it to unload, as #48 does), installs the new one, and rolls back on failure.
  The listener profiles move the same way. This is the one place where a rename can cost mail, so it needs an E2E
  test and a walk on a real Mac.
- **Agent configs:** `setup-mcp` already rewrites the entries. The server name stays `agentinbox` for existing configs
  unless the user re-runs setup; Hermes routes confined with `mcp-agentinbox` keep working. The skill and server
  instructions use the new name.
- **Console and docs:** branding, page titles, the setup-token page, README and SKILL.md.

## Questions for Wynn

The decided items above aren't repeated here. Each question has a recommendation, so a plain "yes" to all of them
works.

1. **"Multi-user": one install shared by several people, or many people each running their own?**
   **Rec: each person self-hosts their own (single owner per install, many agents) for M1–M3.** The schema gets an
   `owner_id` from the start, so real multi-user (several logins, each with their own connections, and an admin) can
   be M4 without a rewrite. A hosted multi-tenant service is a different product.
2. **A hosted piece run by the project (an OAuth relay, a shared WHOOP app)?**
   **Rec: no.** Stay fully self-hosted. Notion needs no app thanks to automatic registration, and WHOOP's rules (the
   secret, the 10-member cap, one webhook per app) make a per-user app the only clean option. Its guided setup is 5
   steps.
3. **Hermes's brightspace and hearloom servers: remote HTTP or local stdio, and what auth?**
   **Rec:** if either is stdio, put admin-only stdio in M1 so Hermes can drop all 7 entries. Otherwise stdio waits
   for M4. (Adri can read `~/.hermes/config.yaml` to answer this.)
4. **Google optional in the first-run wizard** (a Notion- or WHOOP-only install skips Google Cloud entirely)?
   **Rec: yes.** It's the biggest win for a public product: the Google path is 8 steps.
5. **Default policy for newly connected tools:** hidden until reviewed, then reads allowed, writes need approval,
   deletes denied, with "Approve all read tools" in one click.
   **Rec: yes.** The alternative of allowing all reads automatically is faster to set up but loses the rug-pull
   protection.
6. **Approvals on your phone:** approval cards stay in the console, and the broker emits `approval.requested` so
   Hermes can message you on Telegram with a link.
   **Rec: yes, link only.** Approving from Telegram itself (a reply that approves) is M4 at the earliest, because a
   chat reply is spoofable.
7. **Rename details:**
   - New agent keys use a new prefix, with `aib_` valid forever. **Rec: keep `aib_` for everything.** It's invisible
     to users, and changing it costs more than it gives.
   - Keep `~/.agentinbox` for existing installs. **Rec: yes.** No automatic data move.
8. **Search mode for Hermes:** Hermes loads every tool. **Rec: turn search mode on automatically for any agent with
   more than about 30 tools**, with real tool names kept for agents under that.
9. **Order after M1:** **Rec: M2 WHOOP, then M3 search mode.** If Hermes's tool count is already over about 50 after
   M1, swap the order.
