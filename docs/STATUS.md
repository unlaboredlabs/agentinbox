# Status: Calendar + listener-recipe round (resumed on forge 2026-10-16)

The work paused when Wynn's Claude usage ran out on anvil and resumed on forge under a new lead. Everything below is pushed
to GitHub, and no work exists only on a local disk. This file is the source of truth; update it at every checkpoint.

**Goal (from Wynn, via Adri):**
- Google Calendar support, plus a clean "Add Google Calendar" upgrade for installs that already exist.
- Listener fixes from Wynn's real install.

**Design and decisions:** see [docs/calendar.md](calendar.md). The **"Review amendments"** section at its end overrides
anything earlier in that doc.

## Done (merged on main, CI green)

| PR | What |
| --- | --- |
| #37 | Calendar contract: types, migration 7, scopes (`calendar.events`, `calendar.calendarlist.readonly`, `calendar.events.freebusy`), stubs, plan |
| #38 | Listener routing: `--recipe hermes` forwards to the Hermes gateway (`hermes-oneshot` is opt-in), triage prompts with visible output, `--not-from`/`--not-label`, Promotions/Social/Forums skipped by default, `--batch`, an honest `listen service install` (verified via launchctl/systemctl, rollback), a stable Node ≥ 22.13 |
| #39 | Calendar A: REST client, fake Calendar API (`test/fake-google.ts`), syncToken sync engine, event emission, backoff, demo data |
| #40 | Calendar B: grants (`calendar.read`/`calendar.write`, `calendarScope`, `calendarWriteMode` direct/approval), allowTo for attendees, shared send caps, approvals for calendar writes (If-Match, idempotent ids, re-check on approve), audit, plain-words denials |
| #41 | Calendar D: scopes on connect, incremental consent (`include_granted_scopes`, token swap without revoking), scope backfill, mail-only reconnect, setup state and warnings, optional push channels |

### Key decisions

- **Calendar writes:**
  - `calendar.write` gates the write tools; `calendarWriteMode` (default `approval`) decides how a write runs. "None" in the UI means no `calendar.write`.
  - Update, delete and RSVP also need `calendar.read`.
  - Agent-created events notify attendees by default. allowTo, the send caps and approval mode are the brakes.
- **Sync:** default polling is 60 s with syncToken. Push only works when `publicUrl` is public https, and polling stays on as a safety net.
- **Hermes:**
  - The route is confined to `toolsets: ["mcp-agentinbox"]`.
  - `listen hermes --run` refuses unless `agentinbox` is an enabled MCP server in Hermes. Run `npx agentinbox-cli setup-mcp --tool hermes` first.
  - `--cron-job` requires that job's `enabled_toolsets` to be exactly `["agentinbox"]`.

## Round complete (2026-10-16, forge lead)

- Merged after one fresh review each (blockers fixed, nits in FOLLOWUPS.md): #42 C (MCP calendar tools; recurring
  events need `time_zone`, series ids shown), #43 E (Add Google Calendar flow), #46 G (delivery, calendar E2E against
  the fake Calendar API: read, write, approval, delivery, upgrade from a pre-calendar DB with 2 accounts and mail
  flowing), #44 F (console grants/approvals; approval times shown in the event's zone).
- Fresh-persona walks: new install (no blockers) and the existing-install upgrade starting from the real
  `nightly.34` (no mail lost or duplicated). #47 fixed what they found: a warning when the listener forwards to a
  Hermes route that puts event content into an unconfined prompt (routes with a `cron_job` or a placeholder-free
  prompt don't warn), a note that Promotions/Social/Forums are now skipped by default, "No calendar access" on the
  pairing presets, and upgrade docs (README, calendar.md, listen.md "Upgrading an existing listener").
- Open decision for Wynn: Forums in the default category skip (see FOLLOWUPS.md, "Open decisions").
- Persona walk tooling: `/tmp/personas/BRIEF.md`; user-space headless Chromium in `~/.cache/aib-browser` (needs a
  font via `FONTCONFIG_FILE`); T3's preview browser needs `sudo t3 browser setup` on this host.

## After the round (2026-10-16)

- #48: macOS `service install` waits for launchd to unload the old job and retries error 5 (server, rollback and
  listener). `list_calendar_events` no longer shows a false "(UTC)" label or "You organize it" for imported
  calendars.
- #49: the repo moved to `wynn-dev/agentinbox` and the URLs were updated. The launchd labels deliberately stay
  `com.unlaboredlabs.*`.
- #50: attachments on `create_draft`, `reply` and `send_message` (25 MB per message, at most 10 files, Gmail-blocked
  types refused, filenames cleaned and decoded, shown on approval cards, audited). Published as `nightly.48`.

## Current: xaq (renamed 2026-10-16) — MCP broker + extensions shipped

- **Renamed:** repo `wynn-dev/xaq` (was `wynn-dev/agentinbox`), package `xaq-cli`, bin `xaq`, #60.
  - The first xaq-cli nightly is `0.1.0-nightly.71` (main 54b04b0), published via OIDC with provenance.
  - The last agentinbox-cli nightly is `0.1.0-nightly.69`.
- **Broker:** everything in [docs/MCP-BROKER.md](MCP-BROKER.md) M1–M3 is merged (#52–#72). Nits are in FOLLOWUPS.md.

- **After Wynn's first Mac upgrade (2026-10-16):**
  - #74: ownership-aware dirs (a foreign `~/.config/xaq` is never used or touched; agentinbox dirs stay in use). Published in `nightly.73`.
  - #75: in search mode every tool stays callable by name; agents from before the upgrade are pinned to direct; `auto` is decided once. WHOOP polls without webhooks (a reconciliation poll that keeps running even with webhooks), the webhook step appears only on a really public URL, and Tailscale gets an optional Funnel step. Published in `nightly.74`.
  - #77: the tool-change pin/hold is removed (Wynn's decision; don't re-add): a changed tool is used at once, with only an audit entry. Published in `nightly.75`.
  - #76: the T3 Code preset (tier L): MCP OAuth, http only on private/tailnet addresses, same-origin sign-in, 30-day expiry with a warning and Reconnect, several servers, a risk table. Published in `nightly.76`.
  - T3 E2E rule: only a disposable `t3 serve` under `env -i` with a fresh `T3CODE_HOME`. Never the live :3773, `~/.t3` or `~/.hermes/mcp-tokens`.

- **Extensions (Wynn's decision, 2026-10-16):** see [docs/EXTENSIONS.md](EXTENSIONS.md).
  - The core is lean. Notion, T3 Code, Brightspace (remote manifests) and WHOOP (a code extension) live in
    [wynn-dev/xaq-extensions](https://github.com/wynn-dev/xaq-extensions), pinned by commit and integrity in its
    `index.json` and in core's `server/extensions/bootstrap.json` (all at `4130a3a`).
  - xaq #79 is the contract, #81 the store/CLI/console, #80 the manifests and migration (no re-auth; a data snapshot
    of the official notion/t3code manifests keeps already-bound connections gated as before), #82 the code host
    (stdio child under `node --permission`, `--no-experimental-sqlite`, a signal preload; Node floor for code
    extensions 22.23.2 / 24.18.1 / 26.5.1) and #83 the release pins. xaq-extensions #1–#4. Published in `nightly.82`.
  - WHOOP: the extension reads the WHOOP API live (no DB, no polling, no events) with a scored-days cache. Parity with
    the dashboard MCP passed on Wynn's Mac on 2026-10-17 (570 checks, 53 days). The extension now holds the slug
    `whoop`, and Hermes uses it. Adri and Wynn tear down the dashboard: don't touch it.
  - Wynn's connections: `notion-personal`, `notion-work`, `whoop` (extension), `brightspace-tud`.
- **Dropped:** moving forge's T3 servers into xaq (Hermes keeps its own T3 entries). Don't touch any T3 pairing.

Open, in order:
1. **`connections add <url> --yes` with a header key at the hidden prompt** ends `needs_reauth`, while `reconnect`
   with the same value works (Wynn, twice). Tier S fix in progress; ships in the next nightly.
2. **Wynn repoints `agentinbox-cli`'s npm trusted publisher** to `wynn-dev/xaq` + `shim.yml`. Then: run `shim.yml`,
   `npm deprecate agentinbox-cli …`, and `npm deprecate xaq-cli@0.0.0-stage …`. Don't run `shim.yml` before that.
3. **Re-check the code-extension Node floor** after Node's 2026-10-21 security release (`CODE_EXTENSION_NODE_FLOOR`).
4. **Open decisions / checks with Wynn:** the Hermes import (one entry or two; the rec is two, keeping a mail-only
   `agentinbox` entry for routes confined with `mcp-agentinbox`); Hermes in search mode (opt-in from the agent's
   "Tool list" card).

## Rules (Wynn / Adri)

- Finite exit, blockers-only gates. Nits go to `docs/FOLLOWUPS.md`.
- Tier L (2 reviewers, one of them security) for anything touching scopes, auth or grants; tier M otherwise.
- Use opus at high effort, a worktree per writer, and one serial merge train.

The follow-ups from the anvil round are now in [docs/FOLLOWUPS.md](FOLLOWUPS.md).
