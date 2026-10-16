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

## Current: MCP broker (M1–M3 code merged, 2026-10-16)

Plan: [docs/MCP-BROKER.md](MCP-BROKER.md). Everything is decided, including Wynn's approval model. Built in parallel
(up to 20 agents), with tier-L reviews (2 reviewers plus a security reviewer) per area, and merged in one serial train:
- #52/#56 contracts (`server/broker/types.ts`);
- #53 schema (migration 8);
- #55 SDK ADR plus fake upstreams;
- #54 Notion preset; #57 WHOOP native;
- #59 catalog/pinning; #61 policy/approvals; #62 upstream OAuth/credentials; #63 endpoint/events/API wiring;
- #58 search mode; #65 console; #66 CLI connections/import; #64/#67/#68 docs and tests.

Open:
- **Rename** to xaq: PR #60, a draft. It needs the GitHub repo rename by Adri first (see its runbook).
- **New-user E2E walk:** running.
- **Real-world checks that need Wynn:**
  - Notion connect (M1 #2);
  - Hermes migration (M1 #3). Open decision: one entry or two; the rec is two, keeping a mail-only `agentinbox` entry for confined routes;
  - WHOOP with his own developer app (M2).
- Nits from every review are in FOLLOWUPS.md under "MCP broker build".

## Rules (Wynn / Adri)

- Finite exit, blockers-only gates. Nits go to `docs/FOLLOWUPS.md`.
- Tier L (2 reviewers, one of them security) for anything touching scopes, auth or grants; tier M otherwise.
- Use opus at high effort, a worktree per writer, and one serial merge train.

The follow-ups from the anvil round are now in [docs/FOLLOWUPS.md](FOLLOWUPS.md).
