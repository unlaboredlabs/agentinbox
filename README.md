# xaq

[![CI](https://github.com/wynn-dev/xaq/actions/workflows/ci.yml/badge.svg)](https://github.com/wynn-dev/xaq/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/xaq-cli)](https://www.npmjs.com/package/xaq-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A self-hosted MCP broker for AI agents (formerly agentinbox, see [Upgrading from agentinbox](#upgrading-from-agentinbox)). One small server holds all your credentials (Notion, WHOOP, any MCP server,
Gmail and Google Calendar) and gives each agent a single MCP endpoint with only the tools it's allowed. Risky actions
(deleting, sending, publishing, payments) can wait for your one-tap approval, and every call is audited.

```sh
npx xaq-cli
```

Open the link it prints and pick what to connect first: Notion, WHOOP, another MCP server, or Gmail and Calendar.
Only Gmail and Calendar need a Google Cloud project; everything else is a few clicks. The console then connects your
first agent. Requires Node.js 22.13 or newer.

From the terminal on the same machine: `npx xaq-cli connections add notion` (or `whoop`, or an MCP server URL),
and `npx xaq-cli import --from hermes` (also `claude-code`, `cursor`, `codex`) to move an agent's existing MCP
servers behind the broker. Details: [Connections](docs/reference.md#connections-mcp-broker).

For Gmail, Google Calendar is supported too (optional). It needs the Calendar API enabled in your Google Cloud project, the
Calendar scopes on the consent screen, Calendar added to each account, and `calendar.read` (and, to make changes,
`calendar.write`) on the agent's grant. The console's setup covers all of it; existing installs use Overview → "Add
Google Calendar". Details: [docs/calendar.md](docs/calendar.md).

![Overview](docs/screenshots/overview.png)

<!-- rename-xaq: keep-start -->
## Upgrading from agentinbox

xaq is the new name of agentinbox (the npm package `agentinbox-cli` is now `xaq-cli`). An existing install keeps
working as it is; to move it to the new names, run one command per service, on the machine it runs on:

```sh
npx xaq-cli service install                             # the daemon
npx xaq-cli listen service install                      # each listener (add --profile <name> for other profiles)
npx xaq-cli skill install --target <claude|codex|…> --url <your server>   # each agent's skill, if you installed it
```

Each `service install` finds the agentinbox service (launchd `com.unlaboredlabs.agentinbox…`, systemd
`agentinbox.service` / `agentinbox-listen-<profile>.service`), stops it and waits until it is gone, then installs and
starts the xaq one (launchd `sh.xaq.daemon` / `sh.xaq.listen.<profile>`, systemd `xaq.service` /
`xaq-listen-<profile>.service`). The two never run at the same time, and if the new one doesn't start, the old one
is put back exactly as it was. Running it again is a normal reinstall. Mail that arrives meanwhile waits on the daemon
and is delivered once the listener is back: nothing is lost or delivered twice.

**Kept:**
- the data directory: `~/.agentinbox` (or the `--data` directory the old service used) stays in use, with its
  `master.key`, `agentinbox.db` and settings. Nothing is moved; `~/.xaq` is only for new installs.
- every agent key (`aib_…`), Gmail and Calendar connection, grant, webhook and Pub/Sub setup;
- the listener's profiles, keys, logs and event cursor (`~/.config/agentinbox`, `~/.local/state/agentinbox`,
  `~/.local/share/agentinbox` stay in use until the matching `…/xaq` directory holds xaq's own files);
- the names your agents already use: a profile set up with agentinbox keeps its MCP server name `agentinbox`
  (`agentinbox-<profile>`), so Hermes routes confined to `["mcp-agentinbox"]`, cron jobs limited to
  `["agentinbox"]`, the Hermes route `/webhooks/agentinbox…` and Claude Code's `mcp__agentinbox` keep working;
- `AGENTINBOX_*` environment variables: still read when the `XAQ_*` one isn't set, and `--exec` commands still get
  `AGENTINBOX_EVENT_FILE` and the other ids next to the new `XAQ_*` ones.

Another, unrelated program is also called xaq and may have its own `~/.config/xaq` (or `~/.xaq`). xaq counts such
a directory as its own only when it holds xaq's files (`profiles/`, `listen/`, `app/`; in `~/.xaq` its database or
`master.key`), checked without reading anything. Otherwise an existing agentinbox directory is used; and where there
is none, xaq only adds its own files next to the other program's and never changes, renames or deletes anything it
didn't create.

**Changes:**
- the command is `xaq` (`npx xaq-cli …`); `agentinbox` (from the `agentinbox-cli` package, now a shim) and
  `npx agentinbox-cli …` still work: they run xaq after saying so;
- the service names above, and the services write `XAQ_*` variables;
- new profiles and setups use `xaq` / `xaq-<profile>` for the MCP server and Hermes route, and the skill is
  installed as `xaq` (replacing the `agentinbox` one);
- the console, logs and messages say xaq.
<!-- rename-xaq: keep-end -->

## More

- [Reference](docs/reference.md): features, configuration, running as a service or behind a proxy, security model,
  webhooks, data and backups, development
- [Waking local agents with `xaq listen`](docs/listen.md), e.g. `npx xaq-cli listen --recipe claude-code`
- [Screenshots](docs/screenshots/README.md)

## License

[MIT](LICENSE)
