# agentinbox reference

Everything here is optional reading: `npx agentinbox-cli` and the console it links to cover setup. This page is for
running agentinbox in production, scripting it, and understanding what it does.

- [Features](#features)
- [Commands and configuration](#commands-and-configuration)
- [Google Cloud setup in brief](#google-cloud-setup-in-brief)
- [Connecting agents by hand](#connecting-agents-by-hand)
- [Events and webhooks](#events-and-webhooks)
- [Running it](#running-it): [as a service](#as-a-service), [with your own supervisor](#with-your-own-supervisor),
  [on a remote server](#on-a-remote-server), [behind a reverse proxy](#behind-a-reverse-proxy)
- [Security model](#security-model)
- [Data and backups](#data-and-backups)
- [Release channel](#release-channel)
- [Development](#development)

## Features

- **One place for credentials.** Connect Gmail and Google Workspace accounts once. Refresh tokens are encrypted at rest.
  Agents only ever see an `aib_…` key.
- **MCP for every agent.** Streamable HTTP at `/mcp`: `search_threads`, `get_thread`, `reply`, `send_message`,
  `modify_labels`, `wait_for_events` and more. Each agent sees only the tools its grants allow.
- **Real-time delivery.** New mail, replies to threads you sent into, and label changes arrive within seconds through
  Gmail push via a Pub/Sub *pull* subscription (no public URL needed), or within the poll interval (30 seconds by
  default) by polling with zero extra setup.
  [`agentinbox listen`](listen.md) wakes agents on a laptop behind NAT.
- **Webhooks.** Filter by account, label, sender, recipient, subject or attachments. Payloads are signed per
  [Standard Webhooks](https://www.standardwebhooks.com), retried with backoff, logged, and replayable.
- **Guardrails that don't degrade content.** Per agent and mailbox: capabilities, label scope, send mode (direct,
  draft-only or human approval), recipient allowlists, reply-only and send caps. Email content is cleaned, not censored.
- **A web console.** Guided Google setup, connect snippets for Claude Code, Codex, Cursor and Hermes, an approvals inbox,
  live events, delivery logs and the audit trail.
- **A ready-made agent skill.** `SKILL.md` teaches agents to use the tools well and to treat email as data.

## Commands and configuration

The npm package is `agentinbox-cli`; the command it provides is `agentinbox`. Use `npx agentinbox-cli …` for one-off
runs, or `npm i -g agentinbox-cli` and then `agentinbox …`. Every command has `--help`.

```
agentinbox [start] [--port 8425] [--host 0.0.0.0] [--data ~/.agentinbox] [--no-open] [--dev]
agentinbox service install [--port …] [--host …] [--data …]
agentinbox service uninstall [--data …]
agentinbox service status
agentinbox reset-password [--data …] [--port …] [--host …]
agentinbox skill install [--target claude|codex|agents|<dir>] [--url <public url>]
agentinbox skill print [--url <public url>]
agentinbox connect <url> … / setup-mcp / listen …   # on agent machines, see listen.md
```

| Flag | Env | Default | |
|---|---|---|---|
| `--port` | `PORT` | `8425` | Port to listen on |
| `--host` | `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` behind a reverse proxy or SSH tunnel |
| `--data` | `AGENTINBOX_DATA` | `~/.agentinbox` | Data directory |
| | `AGENTINBOX_MASTER_KEY` | | Base64 32-byte key for encrypting secrets, instead of `<data>/master.key` |
| | `TRUST_PROXY` | | `1` behind a reverse proxy: client IPs from `X-Forwarded-For`, https from `X-Forwarded-Proto` |
| | `TRUST_PROXY_HOPS` | `1` | Number of proxies in front of agentinbox (which `X-Forwarded-For` entry, from the right, is the client) |
| | `TRUST_PROXY_FROM` | loopback | Other proxy addresses whose forwarding headers are believed: comma-separated IPs or CIDRs (IPv4 or IPv6) |
| | `AGENTINBOX_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `--url` | `AGENTINBOX_URL` | the agentinbox running on this machine, else `http://localhost:8425` | `skill` commands only: the server URL written into SKILL.md |

Everything else (public URL, ingest mode, poll interval, body size limit, retention, approval expiry, webhook allowlist,
agent pairing) is set in the console under **Settings**.

**Forgot the admin password?** Run `npx agentinbox-cli reset-password` on the server, as the user agentinbox runs as
(`sudo` for a system service) and with the same `--data`. It signs out all sessions and prints a new setup link (for the
running instance's address; pass `--port`/`--host` if it isn't running); a running instance picks it up without a
restart. On an instance that hasn't been claimed yet, it prints the first-run
link instead.

## Google Cloud setup in brief

The console's setup wizard shows every step with the exact values to paste. agentinbox uses **your own** Google Cloud
project and OAuth client: Gmail's read scopes are restricted, so a shared client isn't an option, and this way your mail
never passes through anyone else's app. The parts that most often go wrong:

- **Consent screen audience.** *Internal* if every mailbox is in your Google Workspace organization (no review, no
  expiry). *External* for `@gmail.com` accounts, and then **publish the app to "In production"**: left in *Testing*,
  Google expires refresh tokens after **7 days** and accounts silently disconnect. Google's verification isn't needed
  for your own use: on consent, click *Advanced → Go to (app name)* past the "unverified app" warning.
- **OAuth client** must be of type *Web application*, with the redirect URI the console shows
  (`<public URL>/oauth/callback`). Google won't redirect to plain HTTP on a non-localhost address; the console then uses
  a `localhost` redirect URI and asks you to paste the URL you land on.
- **Scopes.** Each connected account grants `gmail.modify` plus `openid email profile`, nothing more.
- **Real-time delivery (Pub/Sub) setup** asks one connected account for the extra `pubsub` scope, and that account needs
  **Owner** or **Pub/Sub Admin** on the project (Editor can't change topic permissions). A Workspace organization policy
  (domain-restricted sharing) can block granting Gmail's push service
  (`gmail-api-push@system.gserviceaccount.com`); the console says so, and polling (every 30 seconds by default) works
  without any of this.

## Connecting agents by hand

The console (**Agents → Connect an agent**) has copy-paste setup per tool, including device-flow pairing with
`npx agentinbox-cli connect <url>` (see [listen.md](listen.md)). Any MCP client that speaks streamable HTTP works:
endpoint `<public URL>/mcp`, header `Authorization: Bearer <aib_… key>`. For example, Claude Code:

```sh
claude mcp add --transport http --scope user agentinbox https://mail.example.com/mcp \
  --header "Authorization: Bearer $AGENTINBOX_API_KEY"
```

Codex (`~/.codex/config.toml`, with `AGENTINBOX_API_KEY` exported where Codex runs):

```toml
[mcp_servers.agentinbox]
url = "https://mail.example.com/mcp"
bearer_token_env_var = "AGENTINBOX_API_KEY"
```

Cursor (`~/.cursor/mcp.json`) and most other clients take `{"mcpServers": {"agentinbox": {"url": "…/mcp", "headers":
{"Authorization": "Bearer aib_…"}}}}`; Cursor also accepts `"Bearer ${env:AGENTINBOX_API_KEY}"`.

**The agent skill.** `SKILL.md` teaches an agent the tools, Gmail search syntax, reply etiquette, how sends and denials
work, the event loop, and that email content is data, never instructions. Install it where the agent runs (no running
agentinbox needed there), or fetch it from any instance at `/skill.md`:

```sh
npx agentinbox-cli skill install --url https://mail.example.com          # ~/.claude/skills/agentinbox/SKILL.md
npx agentinbox-cli skill install --target codex --url https://mail.example.com
npx agentinbox-cli skill install --target ./skills --url https://mail.example.com
```

## Events and webhooks

Event types: `message.received`, `message.sent`, `thread.reply_received` (a reply in a thread the account sent into),
`label.added`, `label.removed`, `account.auth_failed` and `sync.gap`. Agents only receive events for mailboxes and
labels their grants let them read. `thread.reply_received` is a subset of `message.received` (a reply produces both),
so subscribe to one or the other, not both.

- **Agents without an HTTP endpoint** use the MCP tools `wait_for_events` (long poll), `list_events` and `ack_events`
  while a session runs; the server keeps each agent's position. To start an agent when mail arrives, use
  [`agentinbox listen`](listen.md), e.g. `npx agentinbox-cli listen --recipe claude-code` (new mail only by default;
  `--types` adds the others).
- **Agents with an endpoint** get webhooks (**Webhooks** in the console), optionally with the cleaned message body. A
  delivery succeeds on a `2xx` within 10 seconds (redirects aren't followed); failures are retried 8 times with growing
  delays (30 s up to 12 h, about a day in total) before they're marked dead, and any delivery can be replayed.

**Verifying webhooks.** Each request carries `webhook-id`, `webhook-timestamp` and `webhook-signature` headers (`v1,` +
base64 HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{body}`). Verify them with any
[Standard Webhooks library](https://github.com/standard-webhooks/standard-webhooks) and the `whsec_…` secret shown when
you create the webhook:

```js
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.AGENTINBOX_WEBHOOK_SECRET);
const payload = wh.verify(rawBody, request.headers); // throws if the signature or timestamp is bad
```

A dependency-free Node version is in the [skill](../server/skill/SKILL.md#webhooks). `webhook-id` is the delivery id:
it stays the same across retries and replays of one webhook. To dedupe across webhooks, use the event id `data.id`.

Webhooks may target public `https` URLs and, through the default allowlist (`localhost`, `127.0.0.0/8`, `::1`),
loopback. Other private addresses (a LAN host, `n8n.internal`) must be added to the webhook allowlist in **Settings** as a
hostname, `*.suffix`, IP or CIDR. Plain `http` works only for loopback and allowlisted hosts.

## Running it

Only one agentinbox runs per data directory; a second one refuses to start.

### As a service

```sh
npx agentinbox-cli service install
```

Installs a background service that starts at boot: systemd on Linux (a user service with lingering enabled, or a system
service when run as root) and launchd on macOS. The service runs its own copy of agentinbox (the latest npm release),
installed in the data directory, so it never depends on the npx cache; if that install fails, the running service is
left as it was. Re-run `service install` to update; `service status` and `service uninstall` do what you'd expect, and
uninstalling keeps your data. `--port`, `--host` and `--data` aren't remembered: pass the same ones each time (the
startup banner prints the command with the flags you used). `AGENTINBOX_MASTER_KEY`, `TRUST_PROXY`, `TRUST_PROXY_HOPS`,
`TRUST_PROXY_FROM` and `AGENTINBOX_LOG_LEVEL` are taken from your shell and remembered in `<data>/service.env` (set one
to an empty value to remove it).

When a newer version is published, the console shows **Update available** with the exact command to run.

The unit runs the Node.js binary you installed it with; if you remove or replace that Node, run `service install`
again. If the service doesn't come up, `service install` rolls back and prints where to look (`systemctl --user status
agentinbox`, `journalctl --user -u agentinbox`). Over `su` or `sudo -u` there is often no systemd user session: log in
as that user directly, or enable lingering and set `XDG_RUNTIME_DIR=/run/user/$(id -u)` first.

A service that hasn't been claimed yet doesn't print its setup token to the journal. Get the link with
`npx agentinbox-cli reset-password --data <dir>`.

### With your own supervisor

For Docker, runit, supervisord, pm2 and the like, install the command and run it in the foreground:

```sh
npm i -g agentinbox-cli
agentinbox start --no-open --data /var/lib/agentinbox
```

Use the installed `agentinbox` binary rather than `npx`: npx doesn't pass stop signals on, so agentinbox wouldn't shut
down cleanly.

### On a remote server

Over SSH, the startup banner prints the tunnel command to run on your laptop, for example
`ssh -L 8425:localhost:8425 you@server` (your usual ssh host or alias works too); then open the printed `localhost`
setup link in your laptop's browser. Until
the instance is claimed, anyone who can reach its port could claim it first: start it with `--host 127.0.0.1` and use
the tunnel, or firewall the port. The banner warns when the port is reachable on a public address.

### Behind a reverse proxy

agentinbox serves plain HTTP. To expose it beyond your network, put it behind a TLS-terminating proxy (Caddy, nginx,
Tailscale Funnel) and:

- bind it to localhost: `--host 127.0.0.1`
- set `TRUST_PROXY=1`, so lockouts apply per client and cookies are marked `Secure` on https. The client address is
  taken from the right end of `X-Forwarded-For`; with more than one proxy in front, set `TRUST_PROXY_HOPS` to their
  number. Forwarding headers are believed only from a proxy on the same host (loopback); if the proxy runs on another
  machine, list its address in `TRUST_PROXY_FROM` (for example `10.0.0.5` or `10.0.0.0/24`; `/0` is refused). The
  proxy must append to (or overwrite) `X-Forwarded-For`; one that passes the header through unchanged lets clients
  choose their own address
- set **Settings → Public URL** to the https address, so MCP snippets, the skill and the OAuth redirect use it

`GET /health` (or `/api/health`) needs no auth and suits uptime monitors: `200` when healthy, `503` when degraded (for
example when an account needs to be reconnected or ingest is failing). It reports only a status, the version and
whether setup is complete.

## Security model

agentinbox assumes agents can be manipulated by the mail they read. So it keeps content intact and puts the hard limits
on actions.

**Content is cleaned, not censored.** Agents get full-fidelity mail converted to Markdown, with links and tables. Only
what a human reader couldn't see is removed: hidden CSS (`display:none`, zero-size, transparent or same-colour text),
HTML comments, scripts and styles, zero-width characters, Unicode tag characters and bidi overrides. Each body is
wrapped in one `<email_content … untrusted>` delimiter and comes with signals: SPF/DKIM/DMARC results, an
external-sender flag, whether hidden content was removed, and phrases typical of prompt injection. Signals are
informational; nothing is withheld because of them. Very long bodies are cut at 20,000 characters by default
(Settings), with a note saying so.

**Actions are strictly controlled.** A new agent can do nothing. Each grant (agent × mailbox) sets:

| Control | |
|---|---|
| Capabilities | `read` (search, read, attachments, events), `draft`, `send`, `organize` (labels, archive, read state), `trash` |
| Label scope | Confine the agent to threads carrying certain labels. Searches are rewritten and fetches by id are checked; anything outside looks "not found". |
| Send mode | `draft_only` (default: a Gmail draft for a human to send), `approval` (queued in the console; approving sends it) or `direct` |
| Allowed recipients | Exact addresses or globs such as `*@example.com` |
| Reply only | No new messages or forwards; replies only, inside threads the agent can see, to people already in the conversation. The reply goes to the message's Reply-To or From, which the sender chooses: use Allowed recipients to limit who can be written to. |
| Send caps | Per rolling hour and 24 hours, counting sends that became drafts or approvals too |

**Everything is audited.** Every tool call and every console change is recorded with its outcome, and denials name the
guardrail that blocked them.

**The console** is protected by an admin password (set through the one-time setup link), HttpOnly session cookies that
expire after 30 days of inactivity (90 at most), a CSRF header on every API change, request size limits, a Content
Security Policy that allows only the console's own scripts, and a 15-minute lockout after five wrong passwords (or 30
attempts) from one address. When failures pile up across many addresses, every sign-in attempt is slowed down instead.
It never allows being framed. The data directory and database are readable only by their owner.

Recommendations: split agents that read untrusted mail from agents that can send; prefer `draft_only` or `approval`;
use allowlists for anything that sends directly.

## Data and backups

Everything lives in the data directory (`~/.agentinbox` by default):

| File | |
|---|---|
| `agentinbox.db` | SQLite database (plus `-wal` and `-shm` files): accounts, encrypted tokens, agents, grants, events, deliveries, approvals, audit log |
| `master.key` | Encrypts Google tokens, webhook secrets and the OAuth client secret (mode 0600) |
| `setup-token` | The one-time setup token, until the instance is claimed |
| `agentinbox.lock` | Marks the running instance (pid and port) |
| `service.env` | Environment the service was installed with, possibly including `AGENTINBOX_MASTER_KEY` (mode 0600; `service install` only) |
| `agentinbox.log` | Service output on macOS (launchd); on Linux use `journalctl --user -u agentinbox` (or without `--user` for a system service) |
| `app/` | The service's own install (`service install` only) |

Back up `agentinbox.db` and `master.key` together: without the key, stored secrets can't be decrypted, and agentinbox
refuses to start rather than create a new one. Keep the key somewhere safer than the database backup, or supply it via
`AGENTINBOX_MASTER_KEY`. The database runs in WAL mode, so don't just copy the file while agentinbox is running: stop
it first (`systemctl --user stop agentinbox`), or take a consistent copy with
`sqlite3 ~/.agentinbox/agentinbox.db ".backup /path/to/backup.db"`.

Received mail bodies are never stored; agentinbox keeps metadata (ids, headers, labels, snippets) and fetches content
from Gmail on demand. The only bodies in the database are those of sends queued for approval. Events, deliveries,
audit entries and decided approvals (with their bodies) are pruned after the retention period set in **Settings** (30
days by default).

## Release channel

Every push to `main` (a quick second merge can supersede the first) is published to npm as
`agentinbox-cli@<version>-nightly.<n>` under the `latest` tag, built by GitHub Actions with npm trusted publishing and
[provenance](https://docs.npmjs.com/generating-provenance-statements). `npx agentinbox-cli` therefore runs the newest
build of `main`, and `service install` always installs `latest`. To stay on one build, run it pinned in the foreground:
`npx agentinbox-cli@<version>`.

## Development

```sh
pnpm install
AGENTINBOX_DATA=/tmp/agentinbox-dev pnpm dev
```

`pnpm dev` runs the server on `:8425` in watch mode (API, MCP and OAuth only) and the console on Vite at `:5173`, which
proxies to it. Open the Vite URL; the printed setup link already points there.

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm build           # console → dist/web, server → dist/cli.js
node dist/cli.js     # run the build
```

Stack: TypeScript on Node 22+, Hono on `@hono/node-server`, `node:sqlite`, the MCP TypeScript SDK, and thin fetch-based
Google clients (no `googleapis`, so `npx` stays fast). The console is Vite, React 19, TanStack Router / Query / Table /
Form and shadcn/ui on Tailwind v4.
