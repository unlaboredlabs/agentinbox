# agentinbox

[![CI](https://github.com/unlaboredlabs/agentinbox/actions/workflows/ci.yml/badge.svg)](https://github.com/unlaboredlabs/agentinbox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agentinbox-cli)](https://www.npmjs.com/package/agentinbox-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A self-hosted Gmail broker for AI agents. One small daemon holds your Gmail credentials; every agent gets its own
scoped API key and reaches mail through **MCP tools** (read, search, draft, send, organize) and **signed webhooks** or an
MCP event feed for new mail. Guardrails decide what each agent may do per mailbox, every action lands in an audit log,
and a web console makes setup and management painless. It runs anywhere Node does, against your own Google Cloud
project, with no cloud service in between.

## Features

- **One place for credentials.** Connect Gmail and Google Workspace accounts once. Refresh tokens are encrypted at rest.
  Agents only ever see an `aib_…` key.
- **MCP for every agent.** Streamable HTTP at `/mcp`: `search_threads`, `get_thread`, `reply`, `send_message`,
  `modify_labels`, `wait_for_events` and more. Each agent sees only the tools its grants allow.
- **Real-time events.** New mail, replies to threads you sent into, and label changes arrive within seconds through
  Gmail push via a Pub/Sub *pull* subscription (no public URL needed), or by polling with zero extra setup.
- **Webhooks.** Filter by account, label, sender, recipient, subject or attachments. Payloads are signed per
  [Standard Webhooks](https://www.standardwebhooks.com), retried with backoff, logged, and replayable.
- **Guardrails that don't degrade content.** Per agent and mailbox: capabilities, label scope, send mode (direct,
  draft-only or human approval), recipient allowlists, reply-only and send caps. Email content is cleaned, not censored.
- **A console you'll actually enjoy.** Guided Google setup, connect snippets for Claude Code, Codex and Cursor, an
  approvals inbox, live events, delivery logs and the audit trail. Dark mode included.
- **A ready-made agent skill.** `SKILL.md` teaches agents to use the tools well and to treat email as data.

<!--
## Preview

![Overview](docs/screenshots/overview.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/setup.png" alt="Setup wizard"><br>Guided Google Cloud setup.</td>
    <td width="50%"><img src="docs/screenshots/agents.png" alt="Agents"><br>Agents, grants and connect snippets.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/approvals.png" alt="Approvals"><br>Approve or reject sends.</td>
    <td><img src="docs/screenshots/webhooks.png" alt="Webhooks"><br>Webhooks with delivery log and replay.</td>
  </tr>
</table>
-->

## Quick start

Requires Node.js 22.13 or newer.

```sh
npx agentinbox-cli
```

The npm package is `agentinbox-cli`; the command it provides is `agentinbox`. Use `npx agentinbox-cli …` for one-off
runs, or `npm i -g agentinbox-cli` and then `agentinbox …`.

agentinbox starts on port 8425 and prints a one-time setup link (and opens it if it can):

```
  agentinbox v0.1.0 · data in /home/you/.agentinbox

  First run: open this link to claim the instance and finish setup:

  http://localhost:8425/setup?token=…
```

Open it, choose an admin password, and the setup wizard walks you through the rest in about ten minutes.

## Setting up Google

agentinbox uses **your own** Google Cloud project and OAuth client. Gmail's read scopes are restricted, so a shared
client isn't an option, and this way your mail never passes through anyone else's app. The wizard shows each step with
the exact values to paste; in short:

1. **Create a Google Cloud project** and enable the **Gmail API** (and the **Cloud Pub/Sub API** if you want push).
2. **Configure the OAuth consent screen** (Google Auth Platform → Audience):
   - **Internal** if every mailbox is in your Google Workspace organization. No review, no expiry, nothing else to do.
   - **External** for personal `@gmail.com` accounts (or mailboxes outside your org). Then **publish the app to
     "In production"**. Left in *Testing*, Google expires refresh tokens after **7 days** and your accounts silently
     disconnect. You don't need Google's verification for your own use: on consent, click *Advanced → Go to
     (app name)* past the "unverified app" warning.
3. **Create an OAuth client** of type *Web application*, add the redirect URI the console shows
   (`<public URL>/oauth/callback`), and paste the client ID, client secret and project ID into the console.
4. **Connect accounts.** Each one goes through Google's consent screen. If the console is on plain HTTP at a non-localhost
   address, Google can't redirect back to it; the console then asks you to paste the URL you land on instead.
5. **Choose how new mail arrives:**
   - **Pub/Sub (recommended):** one click creates the topic, grants Gmail's push service
     (`gmail-api-push@system.gserviceaccount.com`) permission to publish, and creates a pull subscription, using a
     connected account that can manage Pub/Sub in the project. Events arrive in seconds, with no inbound connections.
     If a Workspace organization policy (domain-restricted sharing) blocks that grant, the console says so; use polling.
   - **Polling:** no extra setup; checks each mailbox every 30 seconds by default.

Then create an agent and give it a grant on a mailbox.

## Connecting agents

Create an agent in the console (**Agents → New agent**) to get its API key; the key is shown once. The console has
copy-paste snippets with your URL and key filled in, and a **Test connection** button. By hand:

**Claude Code**

```sh
claude mcp add --transport http agentinbox http://your-host:8425/mcp --header "Authorization: Bearer aib_…"
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.agentinbox]
url = "http://your-host:8425/mcp"
bearer_token_env_var = "AGENTINBOX_KEY"
```

**Cursor** (`~/.cursor/mcp.json`) and most other MCP clients

```json
{
  "mcpServers": {
    "agentinbox": {
      "url": "http://your-host:8425/mcp",
      "headers": { "Authorization": "Bearer aib_…" }
    }
  }
}
```

Any MCP client that speaks streamable HTTP works: endpoint `/mcp`, header `Authorization: Bearer <key>`.

### The agent skill

`SKILL.md` teaches an agent the tools, Gmail search syntax, reply etiquette, how sends and denials work, the event loop,
and that email content is data, never instructions. Install it on the machine where the agent runs (no running
agentinbox needed there):

```sh
npx agentinbox-cli skill install --url https://mail.example.com          # ~/.claude/skills/agentinbox/SKILL.md
npx agentinbox-cli skill install --target codex --url https://mail.example.com
npx agentinbox-cli skill install --target ./skills --url https://mail.example.com
npx agentinbox-cli skill print --url https://mail.example.com             # to stdout
```

Every instance also serves it at `/skill.md` with its public URL filled in.

## Events and webhooks

Event types: `message.received`, `message.sent`, `thread.reply_received` (a reply in a thread the account sent into),
`label.added`, `label.removed`, `account.auth_failed` and `sync.gap`. Agents only receive events for mailboxes and
labels their grants let them read.

- **Agents without an HTTP endpoint** (most coding agents) use the MCP tools `wait_for_events` (long poll),
  `list_events` and `ack_events`. The server keeps each agent's position.
- **Agents with an endpoint** get webhooks: create one under **Webhooks**, pick event types and filters, and optionally
  include the cleaned message body. Failed deliveries retry with exponential backoff before they're marked dead, and
  any delivery can be replayed from the console.

Each webhook request carries `webhook-id`, `webhook-timestamp` and `webhook-signature` headers. Verify them with any
[Standard Webhooks library](https://github.com/standard-webhooks/standard-webhooks) and the `whsec_…` secret shown when
you create the webhook:

```js
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.AGENTINBOX_WEBHOOK_SECRET);
const payload = wh.verify(rawBody, request.headers); // throws if the signature or timestamp is bad
```

A dependency-free Node version is in the [skill](server/skill/SKILL.md#webhooks).

By default webhooks may only target public addresses and loopback; other private addresses (for example a LAN host or
`n8n.internal`) must be added to the webhook allowlist in **Settings**.

## Security model

agentinbox assumes agents can be manipulated by the mail they read. So it keeps content intact and puts the hard limits
on actions.

**Content is cleaned, not censored.** Agents get full-fidelity mail converted to tidy Markdown, with links and tables.
Only what a human reader couldn't see is removed: hidden CSS (`display:none`, zero-size, transparent or
same-colour text), HTML comments, scripts and styles, zero-width characters, Unicode tag characters and bidi overrides.
Each body is wrapped in one `<email_content … untrusted>` delimiter and comes with signals: SPF/DKIM/DMARC results, an
external-sender flag, whether hidden content was removed, and phrases typical of prompt injection. Signals are
informational; nothing is withheld because of them.

**Actions are strictly controlled.** A new agent can do nothing. Each grant (agent × mailbox) sets:

| Control | |
|---|---|
| Capabilities | `read` (search, read, attachments, events), `draft`, `send`, `organize` (labels, archive, read state), `trash` |
| Label scope | Confine the agent to threads carrying certain labels. Searches are rewritten and fetches by id are checked. |
| Send mode | `draft_only` (default: a Gmail draft for a human to send), `approval` (queued in the console; approving sends it) or `direct` |
| Allowed recipients | Exact addresses or `*@domain.com` globs |
| Reply only | Sending only inside threads the agent can already see |
| Send caps | Per hour and per day |

**Everything is audited.** Every tool call and every console change is recorded with its outcome, and denials name the
guardrail that blocked them.

**The console** is protected by an admin password (set through the one-time setup link), HttpOnly session cookies
that expire after 30 days of inactivity (90 at most), a CSRF header on every change, request size limits, a strict
Content Security Policy, and a 15-minute lockout after five wrong passwords (or 30 attempts) from one address. When
failures pile up across many addresses, every sign-in attempt is slowed down instead. It never allows being framed.
The data directory and database are readable only by their owner.

Recommendations: split agents that read untrusted mail from agents that can send; prefer `draft_only` or `approval`;
use allowlists for anything that sends directly.

## Running it

### As a service

```sh
npx agentinbox-cli service install
```

Installs a background service that starts at boot: systemd on Linux (a user service with lingering enabled, or a system
service when run as root) and launchd on macOS. The service runs its own copy of agentinbox from the data directory,
so it never depends on the npx cache; a failed install leaves the running service as it was. Re-run `service install`
to update; `service status` and `service uninstall` do what you'd expect, and uninstalling keeps your data. Pass the same
`--port`, `--host` and `--data` options each time. `AGENTINBOX_MASTER_KEY`, `TRUST_PROXY`, `TRUST_PROXY_HOPS`,
`TRUST_PROXY_FROM` and `AGENTINBOX_LOG_LEVEL` are taken from your shell and remembered in `<data>/service.env`, so later
installs keep them (set one to an empty value to remove it).

Only one agentinbox runs per data directory; a second one refuses to start.

When a newer version is published, the console shows **Update available** with the exact command to run.

### Behind a reverse proxy

agentinbox serves plain HTTP. To expose it beyond your network, put it behind a TLS-terminating proxy (Caddy, nginx,
Tailscale Funnel) and:

- bind it to localhost: `--host 127.0.0.1`
- set `TRUST_PROXY=1`, so lockouts apply per client and cookies are marked `Secure`. The client address is taken from
  the right end of `X-Forwarded-For`; with more than one proxy in front, set `TRUST_PROXY_HOPS` to their number.
  Forwarding headers are believed only from a proxy on the same host (loopback); if the proxy runs on another machine,
  list its address in `TRUST_PROXY_FROM` (for example `TRUST_PROXY_FROM=10.0.0.5` or a CIDR like `10.0.0.0/24`; `/0` is refused). The proxy must append to (or overwrite)
  `X-Forwarded-For`; a tunnel or proxy that passes the header through unchanged lets clients choose their own address
- set **Settings → Public URL** to the https address, so MCP snippets, the skill and the OAuth redirect use it

`GET /health` (or `/api/health`) needs no auth and suits uptime monitors: `200` when healthy, `503` when degraded, for
example when an account needs to be reconnected or ingest is failing. It reports only a status, the version and
whether setup is complete.

### Options

With a global install (`npm i -g agentinbox-cli`); otherwise prefix `npx agentinbox-cli` instead of `agentinbox`.

```
agentinbox [start] [--port 8425] [--host 0.0.0.0] [--data ~/.agentinbox] [--no-open] [--dev]
agentinbox service install|uninstall|status [--port …] [--host …] [--data …]
agentinbox skill install [--target claude|codex|agents|<dir>] [--url <public url>]
agentinbox skill print [--url <public url>]
agentinbox reset-password [--data …]
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

Forgot the admin password? Run `npx agentinbox-cli reset-password` on the server, as the user agentinbox runs as (`sudo` for a
system service) and with the same `--data`. It signs out all sessions and prints a new setup link; a running instance
picks it up without a restart.

## Data and backups

Everything lives in the data directory (`~/.agentinbox` by default):

| File | |
|---|---|
| `agentinbox.db` | SQLite database: accounts, encrypted tokens, agents, grants, events, deliveries, approvals, audit log |
| `master.key` | Encrypts refresh tokens, webhook secrets and the OAuth client secret (mode 0600) |
| `setup-token` | The one-time setup token, until the instance is claimed |
| `agentinbox.lock` | Marks the running instance (pid and port) |
| `service.env` | Environment the service was installed with, possibly including `AGENTINBOX_MASTER_KEY` (mode 0600; `service install` only) |
| `agentinbox.log` | Service output on macOS (launchd); on Linux use `journalctl --user -u agentinbox` (or without `--user` for a system service) |
| `app/` | The service's own install (`service install` only) |

Back up `agentinbox.db` and `master.key` together: without the key, stored secrets can't be decrypted, and agentinbox
refuses to start rather than create a new one. Keep the key somewhere safer than the database backup, or supply it via
`AGENTINBOX_MASTER_KEY`. The database runs in WAL mode, so don't just copy the file while agentinbox is running: stop
it first (`systemctl --user stop agentinbox`), or take a consistent copy with
`sqlite3 ~/.agentinbox/agentinbox.db ".backup /path/to/backup.db"`. Mail
bodies are never stored; agentinbox keeps metadata (ids, headers, labels, snippets) and fetches content from Gmail on
demand. Events, deliveries and audit entries are pruned after the retention period set in **Settings** (30 days by
default).

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

## License

[MIT](LICENSE)
