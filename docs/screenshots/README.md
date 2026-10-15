# Console screenshots

Taken from the seeded demo (`scripts/demo/seed.ts`: fake Google, realistic data) with
`scripts/demo/docs-shots.mjs`. 1440 px wide at 1.5× unless noted.

| File | What it shows |
|---|---|
| `overview.png` | Overview: account needing reconnect, agent asking for access, pending approval, 24 h stats and activity |
| `overview-dark.png` | The same in dark mode |
| `overview-mobile.png` | Overview on a phone (390 px, 2×) |
| `wizard-consent.png` | Setup wizard, consent screen step: Internal vs External, the "In production" warning, scopes to add |
| `wizard-oauth-client.png` | Setup wizard, OAuth client step with the copyable redirect URI |
| `wizard-pubsub.png` | Setup wizard, real-time delivery: one-click Pub/Sub or polling |
| `accounts.png` | Gmail accounts, one needing reconnect, with the agents using each |
| `agents.png` | Agents list with the "Connect an agent" entry point and a pending access request |
| `connect-agent.png` | Connect an agent: self-setup prompt, `connect` / approve / `listen` steps per tool |
| `agent-grant-editor.png` | Agent detail: grant editor (capabilities, thread-level label scope, send mode, recipients, caps) |
| `agent-listeners.png` | Agent detail: MCP setup snippets and connected listeners |
| `pairing-request.png` | Approvals, Agent access: a request opened from the terminal's link |
| `pairing-approve.png` | Approving a request: type the terminal's code, choose access (starts at read-only) |
| `approvals.png` | Approvals: a reply waiting for review, with the agent's reason |
| `webhook-deliveries.png` | Webhook detail: plain-language summary and delivery log with a failed attempt expanded |
| `events.png` | Live events feed |
| `audit.png` | Audit log with guardrail denials (rate limit, allowlist) |
| `audit-dark.png` | Audit log in dark mode |
| `settings.png` | Settings: agent pairing toggle, webhook allowlist, Google OAuth client |

Regenerate: start `pnpm exec tsx scripts/demo/seed.ts --port 8531` and
`pnpm exec tsx scripts/demo/seed.ts --port 8532 --fresh --stage pubsub`, then run
`node scripts/demo/docs-shots.mjs` (see the header of that file for the Playwright setup).
