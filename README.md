# agentinbox

[![CI](https://github.com/wynn-dev/agentinbox/actions/workflows/ci.yml/badge.svg)](https://github.com/wynn-dev/agentinbox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agentinbox-cli)](https://www.npmjs.com/package/agentinbox-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A self-hosted MCP broker for AI agents. One small server holds all your credentials (Notion, WHOOP, any MCP server,
Gmail and Google Calendar) and gives each agent a single MCP endpoint with only the tools it's allowed. Risky actions
(deleting, sending, publishing, payments) can wait for your one-tap approval, and every call is audited.

```sh
npx agentinbox-cli
```

Open the link it prints and pick what to connect first: Notion, WHOOP, another MCP server, or Gmail and Calendar.
Only Gmail and Calendar need a Google Cloud project; everything else is a few clicks. The console then connects your
first agent. Requires Node.js 22.13 or newer.

From the terminal on the same machine: `npx agentinbox-cli connections add notion` (or `whoop`, or an MCP server URL),
and `npx agentinbox-cli import --from hermes` (also `claude-code`, `cursor`, `codex`) to move an agent's existing MCP
servers behind the broker. Details: [Connections](docs/reference.md#connections-mcp-broker).

For Gmail, Google Calendar is supported too (optional). It needs the Calendar API enabled in your Google Cloud project, the
Calendar scopes on the consent screen, Calendar added to each account, and `calendar.read` (and, to make changes,
`calendar.write`) on the agent's grant. The console's setup covers all of it; existing installs use Overview → "Add
Google Calendar". Details: [docs/calendar.md](docs/calendar.md).

![Overview](docs/screenshots/overview.png)

## More

- [Reference](docs/reference.md): features, configuration, running as a service or behind a proxy, security model,
  webhooks, data and backups, development
- [Waking local agents with `agentinbox listen`](docs/listen.md), e.g. `npx agentinbox-cli listen --recipe claude-code`
- [Screenshots](docs/screenshots/README.md)

## License

[MIT](LICENSE)
