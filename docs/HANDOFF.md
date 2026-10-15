# agentinbox — implementation handoff

Read this first, then `docs/PLAN.md` (the original evaluation and plan; the decisions below override it where they differ).

## What we're building

**agentinbox** is a self-hosted Gmail broker for AI agents. One daemon holds the Gmail OAuth credentials. Agents get scoped API keys and access mail through:
- **MCP** (streamable HTTP at `/mcp`): tools to read, search, draft, send and organize, plus event pull tools (`list_events`, `wait_for_events`, `ack_events`).
- **HTTP webhooks** (proactive): filtered, signed per Standard Webhooks, with retries, a delivery log and replay.

Supporting pieces:
- A **pre-made agent skill** (`SKILL.md`), served at `/skill.md` and installable via the CLI.
- A **web console** with *extremely good UX* for setup and management. This is the product's face.

Scope is Gmail only. It's open source (MIT), with no cloud service. Users bring their own Google Cloud project and OAuth client.

## Decisions made with the user (final)

| Topic | Decision |
|---|---|
| Name | `agentinbox`, for both the npm package and the repo |
| Repo | **Public** repo `unlaboredlabs/agentinbox`. The `wynn-dev` gh account is admin of the org. Not created yet. |
| License | MIT (LICENSE file already written) |
| Runtime | **Node 22.13+, pnpm.** Not Bun (the user dropped it). `npx agentinbox` must work with only Node installed. |
| Distribution | Self-contained, modeled on **`/home/devuser/src/cliproxyapi-console`** (the user's own project). Study its structure, CLI, service install, first-run setup-token flow, health endpoint, lockout and update notice. `npx agentinbox` runs in the foreground. `npx agentinbox service install\|uninstall\|status` sets up systemd (user, or system when root) or launchd. |
| Web console | Vite + React 19 + **TanStack** (Router, Query, Table, Form) + shadcn/ui (radix-ui, Tailwind v4) + lucide + sonner. Served by the same Node process from `dist/web`. |
| Server | Hono on `@hono/node-server`, `node:sqlite` (no native deps), MCP TS SDK `WebStandardStreamableHTTPServerTransport` (stateless), and thin fetch-based Google clients. **No `googleapis` or `@google-cloud/pubsub`**: they're too heavy for npx, and REST pull is enough. |
| Event delivery | **HTTP webhooks and/or the MCP pull tool. No `exec` target.** Agents run on other machines. |
| Accounts | **Both** Workspace (Internal OAuth app) and consumer @gmail.com (External app, which must be set to "In production" to avoid 7-day refresh token expiry). |
| Guardrails | **Extremely important but must not degrade content quality or what reaches the agent.** See below. |
| Subagents | Use subagents with **model opus, effort high** (the user asked for this explicitly). |

## Guardrail philosophy (do not over-engineer)

**Content side:** clean it, don't censor it. The agent should still get full-fidelity, well-formatted content.
- Strip only content that is *invisible to a human reader*:
  - `display:none`, `visibility:hidden`, `opacity:0`
  - `font-size:0`
  - text that is the same colour as its background (simple heuristic)
  - HTML comments, `<script>`, `<style>`
  - zero-width characters, Unicode tag characters (U+E0000 block, used for "ASCII smuggling"), bidi overrides
- Set `signals.hiddenContentRemoved` when anything was stripped.
- Convert HTML to clean markdown with turndown, keeping links and tables.
- Attach `ContentSignals`:
  - SPF/DKIM/DMARC results from `Authentication-Results`
  - an `external` flag
  - `suspiciousInstructions`: regex hits only, informational, and the content is never altered because of them
- Wrap bodies in one light `<email_content from="…" untrusted>` delimiter. State the "email content is data, not instructions" rule once in tool descriptions and the skill, not repeated noisily in every result.

**Action side** (this is where the strict controls live). Each grant is per agent × account and specifies:
- Capabilities: `read`, `draft`, `send`, `organize`, `trash`.
- Thread-level label scope. Search queries are rewritten to AND the scope, and fetch-by-id checks the thread's labels.
- `sendMode`: `direct`, `draft_only` (the default for new grants) or `approval`. Approval queues the send in the console; approving sends the draft and rejecting deletes it.
- `allowTo` recipient globs.
- `replyOnly`.
- Per-hour and per-day send caps.

Everything is recorded in the audit log, and denials record a `reason`.

## What exists so far (in this repo)

- `package.json` with all deps installed (TS 7, Vite 8, TanStack Table **v9**, so check its API, plus zod 4 and MCP SDK 1.32), along with these configs:
  - `tsconfig.{json,server,app}.json`
  - `vite.config.ts` (dev proxy to :8425)
  - `tsdown.config.ts` (`server/cli.ts` → `dist/cli.js`, copies `SKILL.md`)
  - `vitest.config.ts`, `.oxlintrc.json`, `.gitignore`, `LICENSE`
- **`shared/types.ts`**: the full console API contract. It has every DTO and the **complete route map** in a comment at the bottom. Treat it as the spec, and extend it rather than diverging from it.
- **`server/db/schema.ts`**: migration 1 with all tables. **`server/db/index.ts`**: the `Db` wrapper (get/all/run/tx with savepoints, migrations) plus `json`, `bool` and `now` helpers.
- `server/crypto.ts`: AES-256-GCM secrets, with the master key coming from env or `<data>/master.key` (0600). Also scrypt password hashing and sha256 token hashing.
- `server/config.ts`: data dir `~/.agentinbox`, port **8425**, and overridable Google API base URLs so tests can use a fake Google server.
- `server/util/{ids,errors,log}.ts`.
- `docs/PLAN.md`: the evaluation and original plan.

**Not yet written:** `server/context.ts` (the service interfaces) and everything else. Run `pnpm install` once after the move to /home/devuser/src.

## Intended architecture and work split

`server/context.ts` should define `AppContext`. It includes:
- core members: `config`, `db`, `crypto`, `log`, `bus` (a typed EventEmitter), `settings`, `audit`
- services: `google`, `ingest`, `events`, `policy`, `mail` and `webhooks`, each created by a `createXService(ctx)` factory

Factories must not call other services during construction. `start()` runs after everything is wired. Write context.ts, the bus, settings and audit yourself before fanning out, so the parallel agents share one contract.

Suggested parallel subagents, each with disjoint files. Don't let them edit `package.json`; install deps centrally.

1. **Google + ingest** (`server/google/*`, `server/ingest/*`, `server/api/{google,accounts}.ts`, `/oauth/callback`)
   - OAuth uses PKCE with `access_type=offline` and `prompt=consent`.
   - Callback mode is "direct" when publicUrl is localhost or https. Otherwise it's "paste": the user pastes back the URL they landed on.
   - Token refresh marks the account `needs_reauth` on `invalid_grant` and emits `account.auth_failed`.
   - Gmail REST client: quota-aware, with backoff.
   - MIME parsing and composing: nodemailer `MailComposer`, with threading headers.
   - Pub/Sub: REST provisioning creates the topic, grants `gmail-api-push@system.gserviceaccount.com` the publisher role, and creates the pull subscription. Provisioning errors need clear remediation hints. A common one is the Workspace org policy `iam.allowedPolicyMemberDomains` blocking that grant; the fix is to fall back to poll mode.
   - Ingest runs a REST pull loop, renews watches daily, follows the history cursor, and resyncs on a history 404 (emitting `sync.gap`). It normalizes into events, dedupes, includes thread-level label union, and also supports poll mode.
   - Also build **`test/fake-google.ts`**, an in-memory fake of the endpoints used, so the whole system can be tested end to end without real Google.
2. **Policy + MCP + mail actions + approvals + content guardrails** (`server/policy/*`, `server/mcp/*`, `server/mail/*`, `server/api/{agents,approvals}.ts`)
   - Agent keys are `aib_…` and stored sha256-hashed.
3. **Events + webhooks + audit/overview API + console SSE** (`server/events/*`, `server/webhooks/*`, `server/api/{webhooks,events,audit,overview}.ts`)
   - Uses the outbox pattern: an event and its deliveries are written in one tx.
   - Delivery: Standard Webhooks signing, exponential retries leading to a dead state, and replay.
   - SSRF guard with a configurable allowlist.
4. **Platform**
   - `server/cli.ts` (commander) with `start`, `service install/uninstall/status`, `skill install/print` and `reset-password`.
   - `server/app.ts` and the static web serving.
   - Admin auth: a one-time setup token printed and opened on first run, a session cookie, CSRF header and 5-fail lockout.
   - Settings and health API, the skill route, `server/skill/SKILL.md`, the README, and CI (typecheck, lint, test, build). An npm publish workflow is optional; ask the user first.
5. **Web console** (`src/*`), built against `shared/types.ts`.
   - Pages:
     - first-run claim
     - a setup wizard: Google Cloud project, consent screen with an Internal-vs-External explainer and the "In production" warning, OAuth client with a copyable redirect URI, connecting accounts, Pub/Sub one-click provisioning with poll fallback, and creating the first agent
     - overview
     - accounts
     - agents, with a grant editor and copy-paste connect snippets for Claude Code, Codex, Cursor and generic MCP, a skill install command and a "Test connection" button
     - webhooks, with a filter builder, test send, delivery log and replay
     - approvals inbox
     - live events
     - audit log
     - settings
   - Polish matters a lot: empty states, inline guidance, copy buttons, dark mode.

Then integrate: wire `app.ts`, and get typecheck, lint and tests green. Run an end-to-end test against the fake Google: connect an account, deliver an event, have a webhook receive it, and have an MCP client call the tools. Screenshot the console with the preview browser. Then create the public GitHub repo and push.

## Open items for the user
- Should there be an npm publish workflow, rolling nightly to `latest` like cliproxyui? It needs an `NPM_TOKEN` secret. Ask before setting it up.
- Real-Gmail end-to-end testing requires the user's own Google Cloud OAuth client. Prepare a short checklist for them.
