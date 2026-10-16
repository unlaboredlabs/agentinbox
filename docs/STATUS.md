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

## In flight (pushed, not merged)

- **#42 C** `feat/calendar-c-mcp`: MCP calendar tools and untrusted event content (`<calendar_content … untrusted>`). main is merged in, tests pass. **Needs a review** (security flavour, because invites are an injection vector). The earlier review was stopped before it reported.
- **#43 E** `feat/calendar-e-console-setup`: the "Add Google Calendar" dialog, wizard Calendar steps, account Calendar badges, and "Connect with mail only". main is merged in. **Needs a review.**
- **#44 F** `feat/calendar-f-console-agents`: grant editor calendar section, calendar approval cards, event rows, webhook calendar filters. main is merged in. **Needs a review.** It shares `src/lib/queries.ts` with E (an identical cherry-pick).
- **G** `feat/calendar-g-delivery` (no PR yet), 4 commits:
  - webhook `calendarIds` and calendar matching;
  - `calendar.read` listener streams;
  - listener cleaning and prompts for calendar;
  - mail `send_message` treats a status-0 timeout as "maybe sent";
  - `/me` reports calendar grants;
  - E2E harness prep.

  `scratch/cal-g` has G merged with B, C and D, plus a WIP `test/calendar-delivery.test.ts`.
  - **Not done:** `test/e2e-calendar.test.ts` (read, write, approval, and an upgrade from a pre-calendar DB with 2 accounts and mail flowing throughout), and the docs (`docs/reference.md`, `docs/listen.md`).

## Next (in order)

1. Finish G: write the E2E test and the docs, then open a PR (tier M).
2. Review #42, #43 and #44 (one round each, blockers only).
3. Merge C, E, F, G in that order, rebasing each onto main just before merging.
4. Do two fresh-persona walks, based on `/tmp/personas/BRIEF.md` (on anvil; recreate it if lost). One walk covers the existing-install "Add Google Calendar" upgrade, the other a new install's Calendar step. Fix blockers, re-check only the affected path, then ship.
5. Confirm that `npm view agentinbox-cli dist-tags` shows a nightly built from the final main.
6. Send Adri the done ping with Wynn's exact upgrade steps (nightly, 2 accounts, Pub/Sub, paired Hermes). They must include:
   - updating to the nightly and restarting (migration 7; the restart is the only mail interruption);
   - "Add Google Calendar" from Overview: enable the API, add the Data Access scopes, then Add Calendar for each account;
   - granting `calendar.read`, and optionally `calendar.write`, to Hermes;
   - Hermes: `setup-mcp --tool hermes`, then `listen hermes --run …`. An existing cron-job route needs `enabled_toolsets: ["agentinbox"]`;
   - noting that Promotions/Social/Forums mail is now skipped by default (`--all-categories` to override).

## Rules (Wynn / Adri)

- Finite exit, blockers-only gates. Nits go to `docs/FOLLOWUPS.md`.
- Tier L (2 reviewers, one of them security) for anything touching scopes, auth or grants; tier M otherwise.
- Use opus at high effort, a worktree per writer, and one serial merge train.

The follow-ups from the anvil round are now in [docs/FOLLOWUPS.md](FOLLOWUPS.md).
