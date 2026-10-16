# Extensions (DECIDED by Wynn, 2026-10-16)

xaq's core stays lean. It holds the broker, agents and keys, approvals, the console, the audit log, and Gmail and
Calendar. Every pre-built connection (Notion, T3 Code, Brightspace, WHOOP, …) is an **extension**. Extensions are
installed from the public repo [wynn-dev/xaq-extensions](https://github.com/wynn-dev/xaq-extensions) (MIT) or, behind
a clear warning, from a third-party source.

This file is the contract that the parallel writers build against. A change to it needs the lead's sign-off.

## Two kinds

| Kind | What it is | Runs |
| --- | --- | --- |
| `remote` | A manifest only: an MCP URL (or "the user names the server"), auth hints, setup copy and a risk map. Notion, T3 Code and Brightspace. | Nothing: xaq proxies the remote MCP server, exactly as for presets today. |
| `code` | A manifest plus one bundled Node ESM file that is an MCP server over stdio. WHOOP. | A child process per connection, out of xaq's process, under Node's permission model (below). |

## The manifest: `xaq-extension.json`

It lives at the root of the extension's directory. Unknown keys are rejected (schema 1).

```jsonc
{
  "schema": 1,
  "name": "t3code",                 // [a-z0-9-]{1,32}; unique in the registry; the install's identity
  "displayName": "T3 Code",
  "version": "1.0.0",               // semver; shown, not trusted (the pin is the commit + integrity)
  "description": "…",
  "kind": "remote",                 // "remote" | "code"
  "slug": "t3",                     // default connection slug, [a-z0-9-]{1,24}

  // kind "remote":
  "remote": {
    "url": "https://mcp.notion.com/mcp",               // or omit and use userServer
    "userServer": { "defaultPath": "/mcp", "sameOriginIssuer": true },
    "auth": { "type": "mcp_oauth" }                    // or { "type": "header", "headerName": "Authorization", "prefix": "Bearer " } or { "type": "none" }
  },

  // kind "code":
  "code": {
    "entry": "dist/server.mjs",     // one self-contained ESM file: no node_modules, no install scripts, ever
    "node": ">=22.13",
    "auth": {                       // OAuth is done by xaq core; the extension only ever gets access tokens
      "type": "user_app",           // or "none"
      "authorizeUrl": "…", "tokenUrl": "…", "scopes": ["…"],
      "clientIdInput": "client_id", "clientSecretInput": "client_secret"
    },
    "network": ["api.example.com"],      // declared hosts: shown at install and in the warning (not enforced, see Sandbox)
    "events": ["example.item_updated"]   // the event types it may emit (`<name>.<event>`); anything else is dropped and logged
  },

  "reconnectPolicy": { "maxLifetimeDays": 180, "idleDays": 30, "tokenLifetimeCapDays": 30 },

  // Setup copy: SetupStep[] (server/broker/types.ts). Strings may use {{publicUrl}}, {{redirectUri}}, {{webhookUrl}}
  // and nothing else. A step with "when": "webhookUrl" / "funnel" appears only when that context is present.
  "setup": [ { "id": "app", "title": "…", "body": "…", "copy": { "label": "Redirect URI", "value": "{{redirectUri}}" } } ],

  // The risk map: exact tool names. Anything not listed falls back to the generic rules (annotations + verbs).
  "risk": {
    "tools": { "t3_project_delete": { "class": "risky", "target": "/projectId" }, "t3_project_list": { "class": "read" } },
    "nameCheckExempt": ["t3_thread_send"]
  }
}
```

The manifest becomes an `IntegrationPreset` through `presetFromManifest` (in `server/extensions/manifest.ts`), so the
broker, policy, catalog and console don't change shape. `kind: "code"` maps to `kind: "native"` with a `createSource`
that talks to the child.

## Sources, pinning and the registry

- **Registry:** `index.json` at the root of xaq-extensions:
  `{ "schema": 1, "extensions": [{ "name", "displayName", "description", "kind", "version", "path": "extensions/<name>", "commit": "<40-hex sha>", "integrity": "sha256-<base64>" }] }`.
  It's fetched from `https://raw.githubusercontent.com/wynn-dev/xaq-extensions/main/index.json`. The index is only a
  catalog: what gets installed is pinned by `commit` and `integrity`.
- **Sources for `xaq ext add <name|url|path>`:**
  - a registry name;
  - a GitHub URL `https://github.com/<owner>/<repo>[/tree/<ref>/<path>]`, fetched as the codeload tarball of the
    resolved commit;
  - any other git URL, through the `git` CLI;
  - a local directory, for development and tests.
  Anything that isn't the official registry (wynn-dev/xaq-extensions at the indexed commit) is **third-party**. It
  gets a clear warning before install: the declared network hosts, kind `code` or not, and "this code runs on your
  machine with network access". The CLI needs `--yes` or an interactive confirmation.
- **Integrity:** sha256 over a canonical listing of the extension directory. For each regular file, sorted by POSIX
  path relative to the extension root, the line is `<path>\0<mode 644|755>\0<hex sha256 of content>\n`. Symlinks,
  devices and paths outside the root are refused. It's encoded as `sha256-<base64>`. Core
  (`server/extensions/integrity.ts`) and the repo's `scripts/integrity.mjs` share test vectors and must agree.
- **Pinned installs:** an install records the source, the resolved commit (or, for a local path, none), the integrity,
  the version and the manifest. Files land in `<dataDir>/extensions/<name>/<integrity-hex-prefix>/`, made read-only.
  The integrity is checked again before every child start. A mismatch refuses to start and says why.
- **Updates:** `xaq ext update <name>` shows the old and new version, commit and integrity, and installs only on
  confirmation. Nothing ever updates on its own: an update never swaps code silently.
- **Removal:** `xaq ext remove <name>` is refused while connections use the extension, unless `--force`, which
  disables those connections. Credentials are deleted only by removing the connections.
- **Console:** an Extensions page lists installed extensions with their version, commit, source, official or
  third-party, and the connections using each. It can add from the registry, update with the diff shown, and remove.
  Adding from a URL works with the same warning.

## The code-extension host

- **One child per connection:** `process.execPath --permission --allow-fs-read=<installDir> --allow-fs-read=<stateDir> --allow-fs-write=<stateDir> <installDir>/<entry>`.
  - *Clarified (B3):* one flag per path. Node 22.13.0 and 24.22 both read the comma form
    (`--allow-fs-read=a,b`) as one literal path: on 22.13 the child can't even load its entry. A test pins the argv.
  - No `--allow-child-process`, `--allow-worker`, `--allow-addons` or `--allow-wasi`. Without them, both versions
    refuse `child_process`, `worker_threads`, WASI, `process.dlopen`, `process.binding` and the inspector, and
    symlinks, hard links and `..` out of the allowed paths.
  - `cwd` is `<stateDir>`, stdio is pipes only, `detached: false`, and no other fds are passed (a test checks that
    no regular file xaq holds open, such as the DB, reaches the child).
- **Environment, minimal:** only `XAQ_EXT_NAME`, `XAQ_EXT_CONNECTION_ID`, `XAQ_EXT_STATE_DIR`, `XAQ_EXT_PROTOCOL=1`,
  `TZ`, `LANG`, and `NODE_OPTIONS` unset. Nothing else is inherited, so no `XAQ_*`/`AGENTINBOX_*` secrets, no HOME,
  and no T3 or other variables.
- **State:** `<dataDir>/extension-state/<name>/<connectionId>/`, mode 0700, owned by xaq and deleted with the connection.
  The child never gets xaq's DB, `master.key`, other connections' tokens, the client secret or any path outside
  install and state.
- **Sandbox limits** (documented in the README and the warning): Node's permission model restricts the file system,
  child processes, workers and addons. It does **not** restrict the network. It's a guard against accidents and
  sloppy code, not a hostile-code jail, which is why third-party code extensions get the warning.
- **Protocol:** standard MCP over stdio, with xaq as the client. Extension-to-host custom JSON-RPC:
  - request `xaq/credentials/get`, params `{}`, returns `{ accessToken, expiresAt }` for **this connection only**. xaq
    refreshes it with its single-flight refresher. An error means needs-reauth.
  - notification `xaq/events/emit`: `{ type, dedupeKey, data }`. The type must be in the manifest's `events`. Events
    go through the outbox like native events today.
  - notification `xaq/log`: `{ level, msg, meta }`, rate-limited and redacted.
  - *Clarified (B3), as built in `server/extensions/host`:*
    - Framing is newline-delimited JSON-RPC 2.0 on stdin/stdout (the MCP stdio transport). stdout carries only
      JSON-RPC; anything else is dropped and logged. Use stderr or `xaq/log` for logs.
    - xaq opens with the 2025-era `initialize` handshake (no `server/discover` probe), offering the SDK's latest
      2025 version, with no client capabilities: no sampling, elicitation or roots. The server should declare
      `tools`, and `prompts` and `resources` if it has them; xaq asks only for what's declared.
    - `xaq/credentials/get`: params must be `{}` (or carry only `_meta`). Anything else, such as a connection id, is
      refused with -32602. `expiresAt` is epoch milliseconds, or null when unknown. A refusal is error -32010 with
      `data.reason: "needs_reauth"`. The client secret and the refresh token are never sent.
    - `xaq/events/emit`: `type` matches `<name>.<event>` and is listed in `code.events`; `dedupeKey` is 1 to 200
      printable ASCII characters (unique per occurrence); `data` is a JSON object of at most 8 KB. It's rate-limited
      to a burst of 30, then 1 per second. Anything else is dropped with a log line.
    - `xaq/log`: `level` is `debug`, `info`, `warn` or `error`. `msg` is capped at 500 characters and `meta` at
      1 KB of JSON. Both are redacted, including the access token xaq handed out. It's rate-limited to a burst of 20,
      then 1 per second.
    - Limits per connection: 8 requests in flight (more are refused at once as `rate_limited`), one stdout message
      up to 8 MB (a larger one kills the child, counted as a crash), 15 s to start and finish `initialize`, 30 s per
      list and 60 s per call.
    - The extension must exit when stdin closes (xaq may be gone), and should exit on SIGTERM.
- **Lifecycle:**
  - The child starts when its connection is active and stops (SIGTERM, then SIGKILL after 5 s) on disable, remove,
    update or shutdown.
  - A crash restarts it with backoff; repeated crashes mark the connection `error` with the last stderr lines,
    redacted.
  - *Clarified (B3):* the backoff is 1 s, doubling, up to 60 s. Five crashes in a row (a child that ran for 60 s
    resets the count) mark the connection `error`, and it isn't restarted until the connection is reloaded or xaq
    restarts. A failed integrity check also marks it `error`, with the reason, and never spawns. A good start clears
    an `error` the host set.
  - Scheduled work, such as a polling sync, is the extension's own timer while it runs.

## Prompts and resources

`/mcp` passes upstream prompts and resources through for every connection, remote and code:
- **Prompts** are `<slug>__<name>`.
- **Resources** are `xaq://<slug>/<encodeURIComponent(original uri)>`, with names prefixed `<slug>__`.
- **Templates:** resource templates are passed through the same way.
- **Access:** both are "read" class. An agent sees them when it has any grant on the connection.
- *Clarified (B3):*
  - In a resource template, the literal parts are `encodeURIComponent`-encoded and the `{…}` expressions are kept, so
    a client expands it as usual and the URI decodes back to the upstream's own URI. A variable's value reaches the
    upstream percent-decoded.
  - `prompts/get` and `resources/read` are routed by slug and audited like a read tool call (actions `prompts/get` and
    `resources/read`, target the connection). The lists aren't audited, like `tools/list`. The connection's secrets
    are scrubbed from the results. `uri`s inside them, such as an embedded resource, are rewritten to the `xaq://`
    form, and binaries over 5 MB are left out.
  - The `/mcp` server declares `prompts` and `resources` only for an agent with at least one connection grant. Each
    list asks every granted connection in parallel; one that fails or takes longer than 10 s is left out of that
    answer.

## Migration from core presets (no re-auth)

- **Core:** the Notion, T3 Code and WHOOP presets leave core. Core keeps the generic machinery: remote MCP OAuth,
  `user_app` OAuth with refresh, private-target allow, expiry, events and outbox.
  - *Clarified (B3):* `user_app` OAuth is `server/broker/upstream/user-app.ts`, driven by the preset's auth (a code
    manifest's `code.auth`): authorization code with the client secret in the body, no PKCE, https endpoints only.
    The refresh request sends no `scope`, so the originally granted scope applies (RFC 6749 §6). The native WHOOP
    code sent `scope=offline`. There's no user-id lookup: it only routed webhooks. The generic
    `/hooks/connections/:id` route stays mounted but answers 404, because no preset in core handles webhooks.
- **Pins:** core carries `server/extensions/bootstrap.json`, the pins (name, commit, integrity) of the official notion,
  t3code, whoop and brightspace extensions at release time. It holds pins only, no code.
- **Upgrade, at startup:**
  - each connection whose `preset` is one of these is bound to that extension;
  - a missing extension is installed in the background from its bootstrap pin;
  - until it's installed, a remote connection keeps working as a generic MCP connection (generic risk rules, which
    is the safe direction), and a code one shows "Installing the extension…" with its tools unavailable;
  - tokens, client records, grants, levels and always-allow rules are untouched: nobody re-authorizes.
- **Test:** a DB fixture shaped like Wynn's install: `notion-personal` and `notion-work` (Notion preset), `whoop` (a
  generic MCP connection to the dashboard URL with a bearer key) and `brightspace` (generic, bearer, `127.0.0.1`). After
  the upgrade, all four list and call tools with the same credentials and exposed names.
