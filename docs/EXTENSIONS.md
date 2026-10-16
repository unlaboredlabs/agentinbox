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
      "clientIdInput": "client_id", "clientSecretInput": "client_secret",
      "refreshScope": "offline"     // optional: sent as `scope` on a refresh
    },
    "network": ["api.prod.whoop.com"],   // declared hosts: shown at install and in the warning (not enforced, see Sandbox)
    "events": ["whoop.recovery_updated"] // the event types it may emit; anything else is dropped and logged
  },

  "reconnectPolicy": { "maxLifetimeDays": 180, "idleDays": 30, "tokenLifetimeCapDays": 30 },

  // Setup copy: SetupStep[] (server/broker/types.ts). Strings may use {{publicUrl}}, {{redirectUri}}, {{webhookUrl}}
  // and nothing else. A step with "when": "webhookUrl" appears only when the internet reaches this install.
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

Field rules, all enforced by `validateManifest`. The JSON Schema `MANIFEST_JSON_SCHEMA` (same file, copied into the
repo's `scripts/validate.mjs`) checks the shape; a few rules below are only the validator's.
- **Required:** `schema`, `name`, `displayName`, `version`, `description`, `kind`, `slug`, and `remote` or `code` to
  match `kind`. `reconnectPolicy` (and each of its fields), `setup` and `risk` are optional.
- **`remote`:** exactly one of `url` (https) and `userServer`. `userServer.sameOriginIssuer` defaults to false.
- **`remote.auth.broadScopes`** (with `mcp_oauth` only, optional): granted scopes that mean broad access. The console
  warns when a sign-in grants any of them. T3 Code: `["settings:write", "source-control:write"]`.
- **`reconnectPolicy`:** each field is a whole number of days, from 1 to 3650.
  - `maxLifetimeDays`: a cap on a refreshable sign-in, counted from the sign-in (Notion: 180).
  - `idleDays`: shown only (Notion: 30).
  - `tokenLifetimeCapDays`: for a credential without a refresh token, `expires_at` is the smaller of the token's
    expiry and the sign-in time plus N days. When the server sends no `expires_in`, it is N days (T3 Code: 30).
    Warnings come at 7 days and 1 day, as for any expiry.
- **`setup`:** steps have `id`, `title` and `body`, plus optionally one each of `link`, `copy` and `input` (the
  `SetupStep` shape), and `when`.
  - **Variables:** only `{{publicUrl}}`, `{{redirectUri}}` and `{{webhookUrl}}` (validator only). Any other
    `{{…}}` is an error.
  - **`when`:** the only value is `"webhookUrl"`. A step that uses `{{webhookUrl}}` must have it (validator only).
  - **Links:** a link is https, or starts with one of the variables.
  - **Uniqueness:** step ids and input keys are unique (validator only).
- **`risk.tools[name].class`:**

  | `class` | `ToolClass` | Effect |
  | --- | --- | --- |
  | `"read"` | `{ read: true, risky: false }` | Listed at Read only. |
  | `"write"` | `{ read: false, risky: false }` | Goes through without asking. |
  | `"risky"` | `{ read: false, risky: true }` | Asks at the "ask" level. |

  Tools not listed return null, which means the generic rules (annotations, then the verb list).
- **`risk.tools[name].target`:** a JSON Pointer, or an array of candidate pointers. The first candidate whose
  top-level argument the tool's live `inputSchema` declares becomes the "always allow … for this target" path. If
  none is declared, there is no target. Notion uses `["/page_ids", "/pages", "/page_id", "/ids", "/id"]`.
- **`risk.nameCheckExempt`:** each name must be listed in `risk.tools` and not be `risky` (validator only). The
  table's answer is final for those exact names.
- **`code`:** `entry` is a relative `.mjs` or `.js` path inside the extension. `events` are `<name>.<event>`, which
  limits a name with events to 24 characters. A `user_app` auth's `clientIdInput` and `clientSecretInput` must be
  setup inputs (validator only). Its optional `refreshScope` (OAuth scopes separated by single spaces) passes through
  to the preset's `auth.refreshScope` and is sent as `scope` on a refresh; without it, a refresh sends no scope.
  WHOOP sets `"offline"`.
- **Names:** an extension can't use one of xaq's own event prefixes as its name (`message`, `calendar`,
  `connection`, `approval`, …).

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

- **One child per connection:** `process.execPath --permission --allow-fs-read=<installDir>,<stateDir> --allow-fs-write=<stateDir> <installDir>/<entry>`.
  - No `--allow-child-process`, `--allow-worker`, `--allow-addons` or `--allow-wasi`.
  - `cwd` is `<stateDir>`, stdio is pipes only, and no other fds are passed.
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
- **Lifecycle:**
  - The child starts when its connection is active and stops (SIGTERM, then SIGKILL after 5 s) on disable, remove,
    update or shutdown.
  - A crash restarts it with backoff; repeated crashes mark the connection `error` with the last stderr lines,
    redacted.
  - Scheduled work, such as WHOOP's polling sync, is the extension's own timer while it runs.

## Prompts and resources

`/mcp` passes upstream prompts and resources through for every connection, remote and code:
- **Prompts** are `<slug>__<name>`.
- **Resources** are `xaq://<slug>/<encodeURIComponent(original uri)>`, with names prefixed `<slug>__`.
- **Templates:** resource templates are passed through the same way.
- **Access:** both are "read" class. An agent sees them when it has any grant on the connection.

## Migration from core presets (no re-auth)

- **Core:** the Notion, T3 Code and WHOOP presets leave core. Core keeps the generic machinery: remote MCP OAuth,
  `user_app` OAuth with refresh, private-target allow, expiry, events and outbox.
- **Pins:** core carries `server/extensions/bootstrap.json`, the pins (name, commit, integrity) of the official notion,
  t3code, whoop and brightspace extensions at release time. It holds pins only, no code.
- **Upgrade, at startup:**
  - each connection whose `preset` is one of these is bound to that extension;
  - a missing extension is installed in the background from its bootstrap pin;
  - until it's installed, a remote connection keeps working as a generic MCP connection (generic risk rules, which
    is the safe direction), and a code one shows "Installing the extension…" with its tools unavailable;
  - tokens, client records, grants, levels and always-allow rules are untouched: nobody re-authorizes.
- **Binding:** `connections.preset` holds the extension's name. That is the binding, with no extra column.
  `usedBy(name)` is the ids of the connections `WHERE preset = name` (`server/extensions/bootstrap.ts`).
- **Reconnect before the install:** a bound connection whose extension isn't installed yet can't be reconnected.
  Its sign-in waits for the extension's own rules (T3 Code's same-origin issuer) instead of running generic ones.
  Its tools keep working on the stored credential.
- **The registry:** `presets()` (`server/integrations/index.ts`) stays synchronous. It lists the installed extensions'
  presets, then what is still in core; an installed extension replaces a core preset of the same name.
- **Startup wiring** (the broker's `start()`): `useExtensionStore(extensionStore(ctx))`, then `setHooks` with:
  - `usedBy`, as above;
  - `onRemove`: a forced removal disables the bound connections. Their credentials stay until the connections are
    removed.
  - `onChange`: `reloadPresets()`, then the bound connections are re-listed, which re-classifies their pinned tools
    under the new manifest, or under the generic rules once it's gone.
  A background install from a bootstrap pin re-lists the same way. The broker's `stop()` unregisters the store.
- **Validation:** the store's `checkManifest` is `validateManifest`; an invalid manifest is an `invalid` error.
- **Placeholder pins:** an all-zero commit in `bootstrap.json` installs nothing. The release fills in the real pins.
- **Test:** a DB fixture shaped like Wynn's install: `notion-personal` and `notion-work` (Notion preset), `whoop` (a
  generic MCP connection to the dashboard URL with a bearer key) and `brightspace` (generic, bearer, `127.0.0.1`). After
  the upgrade, all four list and call tools with the same credentials and exposed names.
