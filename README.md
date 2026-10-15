# agentinbox

[![CI](https://github.com/unlaboredlabs/agentinbox/actions/workflows/ci.yml/badge.svg)](https://github.com/unlaboredlabs/agentinbox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agentinbox-cli)](https://www.npmjs.com/package/agentinbox-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A self-hosted Gmail broker for AI agents: one small server holds your Gmail credentials and gives each agent scoped,
audited access through MCP tools and webhooks.

```sh
npx agentinbox-cli
```

Open the link it prints: the console walks you through the rest (Google Cloud setup, connecting Gmail, your first
agent). Requires Node.js 22.13 or newer.

![Overview](docs/screenshots/overview.png)

## More

- [Reference](docs/reference.md): features, configuration, running as a service or behind a proxy, security model,
  webhooks, data and backups, development
- [Waking local agents with `agentinbox listen`](docs/listen.md), e.g. `npx agentinbox-cli listen --recipe claude-code`
- [Screenshots](docs/screenshots/README.md)

## License

[MIT](LICENSE)
