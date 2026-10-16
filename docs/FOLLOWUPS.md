# Follow-ups

Known non-blocking issues from the onboarding sweep (fresh-persona walks p9–p15, Oct 2026). v1 shipped as
`agentinbox-cli@0.1.0-nightly.32` (main f76dc0b) with these open.

## Wording and layout
- Setup step 8's "Setup complete" panel prints "Stop the one in your terminal first (Ctrl-C)" twice: once under the
  listener service command and once under the agentinbox service command. Each line means a different process, so
  name it in each one ("Stop the listener…" / "Stop agentinbox…").
- Step 8's "Keep agentinbox itself running" command includes the daemon's `--data` path. That's correct, but it
  looks odd when the data directory is a temp dir, as in the demo.
- Overview → Recent events: the "address · from Sender" line wraps onto two lines in the narrow card.
- Docs screenshots have no shot of step 8's completed view when the step is revisited.

## Behaviour
- `connect` prints `skill install … --url <url>` without shell-quoting the URL. A URL containing `'` or spaces
  breaks that printed command (the console quotes it).
- A listener's local filters (`--from`, `--label`, `--subject`) run only on the agent's machine. Events that the
  filters skip are still acknowledged, so the console shows them as "Delivered to …".
- Agent page → Recent tool calls filters the last 50 audit rows on the client. An agent with 50+ non-tool
  entries would wrongly show "No tool calls yet". Filter on the server instead.
- The service unit (`service install`, `listen service install`) records `process.execPath`, so upgrading or
  removing a version-managed Node (fnm, nvm, Homebrew keg) breaks the service. Install prints a warning; reuse
  `helperNode()` from `server/listen/mcpheader.ts`.
- `listen --types all` is saved as the expanded list, so event types added later won't reach that profile.
- Migration 6 backfills "setup verified" from `last_mcp_at`, which a bare `claude mcp list` health check sets, so
  an install upgraded between step 7 and step 8 counts as verified.

## Unverified against real Google (the demo uses a fake)
- Whether Google rejects a redirect URI that differs only by a trailing slash, and whether the client check
  catches it.
- Whether enabling `pubsub.googleapis.com` needs a billing account. Step 2 enables only Gmail to stay safe, and
  step 6 warns.
- The real unverified-app and Gmail-permission consent screens, and how Gmail labels the self-sent test email.

## Open decisions (Wynn)
- **Forums in the listener's default category skip.** Shipped default: Promotions, Social and Forums are skipped.
  Proposed: drop Forums from the default (Workspace Google Groups and team lists land there, and Gmail sets the
  label even with inbox tabs off), and have the console say "skipped by listener filter" instead of "Delivered to …"
  for events a listener skipped. Undecided; the default stays as shipped until Wynn decides.

## Calendar + listener-recipe round (Oct 2026)
- The calendar scheduler runs two SQL queries per second, even on mail-only installs.
- An RSVP retry after a 5xx can email the organizer twice.
- Calendar policy retry messages have edge cases; switch them to `isOutcomeUnknown` from the Calendar client.
- Calendar setup tests use their own fakes rather than the shared fake Calendar API in `test/fake-google.ts`.
- Removing an account waits behind the push-channel reconcile.
- Listener: `python3` is required, and on macOS the Xcode `python3` stub is a trap.
- Listener: any loopback `/webhooks/<name>` path gets the wrapped body, not only Hermes routes.
- Listener: Homebrew's `/usr/local/bin` (group-writable) is rejected as the service node.
- Listener: Hermes plugin and native toolsets can still be added to a confined `mcp-agentinbox` route by hand.
- The daemon's own `service install` still records the shell's node (see the service-unit item above).

## Calendar round: reviews and walks (Oct 2026)

### #44 grant editor (grants review)
- Calendar scope picker compares raw Google calendar ids with the server's lowercased stored ids; a mixed-case id
  would show the grant narrower than it is (`calendar-scope-picker.tsx:64`, `server/calendar/setup.ts:225`).
- "Only some" with nothing ticked, then calendar access removed: Save is allowed and the server 400s while the picker
  is disabled (`src/lib/grants.ts:138`).
- An unreadable stored `calendar_scope` becomes `[]`, so saving even a mail-only grant 400s with a confusing error.
- Switching "Only some" → "Every calendar" → "Only some" loses the ticked calendars.
- "Only some calendars" copy doesn't say free/busy lookups for any address stay allowed.
- Grant summary shows "N allowed recipients" on a calendar-read-only grant.

### #44 console agents UI (UX review)
- Events view `grantSees` lets calendar.read-only grants see `sync.gap`; server `canSeeEvent` doesn't
  (`src/components/events/calendar-event.ts:18`).
- Events view compares calendar scope by exact string; the server lowercases (`calendar-event.ts:21`).
- A temporary apply failure returns `pending` + error, but the toast says "Applied to Google Calendar" and the card
  hides `a.error` (mail path has the same issue: "Approved and sent").
- RSVP card: "Comment to the organizer" understates who sees it (all invitees); the guest list is hidden.
- Overview attention says "N messages are waiting" and "(no subject)" for calendar approvals.
- Update approvals show "" (cleared location/description) as empty / "(empty body)" instead of "removed".

### #42 MCP calendar (security review)
- `escapeDelimiters` (`server/mail/content.ts:119`) lets close-tag lookalikes through: markdown-escaped
  `</_calendar\_content_\>`, `<\/calendar_content>`, fullwidth `＜／calendar_content＞`. Allow `[\\_*/\s]` between `<`
  and the name; affects `email_content` too (pre-existing).
- `update_calendar_event` accepts `time_zone` without start/end, then policy rejects it; make schema and policy agree
  (`server/mcp/calendar.ts:376`).
- Event titles in lists can imitate the metadata line (`Standup · event_id: X · You organize it`); quote or label
  titles (`server/mcp/format.ts`).
- `calendar_bad_request`/`calendar_forbidden` pass Google's error text verbatim; clip it with `cleanLine`
  (`server/mcp/server.ts:134`).

### #42 MCP calendar (correctness review)
- `calendar_id` description says default "primary"; B's default is primary-if-in-scope, else the only scoped calendar,
  else `calendar_required`.
- `get_free_busy` description/SKILL.md: defaults to "your calendars" but a null scope queries only primary;
  "colleagues' addresses" is denied under a scoped grant.
- Pending calendar approval message says "check with get_send_status" twice (`agent.ts:577` + `formatCalendarWrite`).
- `describeCalendarError` maps 403 `rateLimitExceeded`/`userRateLimitExceeded` to `calendar_forbidden`; should be
  "wait and retry".
- No test covers moving a recurring series on update (patch without `timeZone` should keep the existing one).
- `formatWhen` drops the end weekday for multi-day timed events when `e.end` is empty (cosmetic).
- `summary` max length is 500 in the MCP schema and 1024 in B.

### #43 Add Google Calendar UI
- `offersMailOnly` (`src/components/accounts/connect-attempt.ts`): with Calendar on, a "Grant Pub/Sub" consent also
  asks for Calendar; under an admin block the mail-only button isn't offered though the server accepts
  `{mailOnly:true, scopes:["pubsub"]}`.
- Paste-callback mode: Add Calendar errors like `oauth_calendar_not_granted` stay inside `PasteCallback`; after
  closing, the result says "sign-in didn't finish".
- A mail-only account behind an admin Calendar block is asked for Calendar on every reconnect; the error should
  suggest Settings → Turn off.
- `step-project.tsx` `EnableApis`: the Gmail `CloudLink` lacks a `disabledReason`.
- Calendar dialog API step shows the `api_disabled` title whenever any consent result exists, not only that account's.
- "New: Google Calendar" notice shows on Overview for a new install that switched Calendar off in the wizard.
- A failed post-consent check derives its result line from possibly stale cached setup state.
- Accounts page title still says "Gmail accounts"; the wizard says "Google accounts".
- Event detail row (`calendarRows` in `src/components/events/event-row.tsx`) shows console-local time labelled with
  the event zone (a 14:00 Tokyo event reads "7:00 AM (Asia/Tokyo)" from Berlin).

### #46 Calendar G
- `test/webhooks-delivery.test.ts` "caps in-flight requests per webhook" is timing-sensitive (failed once under
  full-suite load).
- The listener SSE stream sends calendar events in frames named `event: mail`; rename to `calendar` or document it.
- `test/fake-google.ts` logs only request pathnames; tests can't assert `syncToken` query params or If-Match headers
  directly.
- The upgrade E2E rewinds a migrated DB to the old schema; an old-release fixture DB would be more faithful.
- `test/e2e-calendar.test.ts:359`: the "evented exactly once" check can't fail (`events.dedupe_key` is UNIQUE); count
  what a pre-upgrade listener/webhook receives instead.
- `test/e2e-calendar.test.ts:252`: the `/hooks/mail` "stays empty" check is vacuous; use a mail-only agent with
  `--types all`.
- Calendar E2E lacks `respond_to_invitation`, search, `get_free_busy` and a negative calendar-scope case for
  listener/webhook.
- `--not-from` doesn't skip calendar events while `--from` matches the organizer (`server/listen/event.ts:28`).
- `--types all --label X` lets every calendar event through; label criteria are ignored for calendar events.
- `cleanCalendarEvent` doesn't clean `iCalUID` (sender-controlled via ICS import) (`server/listen/event.ts:50`).
- A status-0 timeout on token refresh is reported as "maybe sent" though the send never left
  (`server/mail/agent.ts:709`).
- Unreachable network/host on an already-open connection could be "maybe sent" for sends
  (`server/google/http.ts:113`).

### New-install walk (Priya)
- `docs/reference.md` Features list omits the calendar MCP tools; "Google Cloud setup in brief" omits enabling the
  Calendar API.
- Claim page says only "connecting Gmail and your first agent".
- Step 3: Data access section is "Optional" before an audience is chosen, "Recommended" after.
- Step 6 doesn't say Calendar is polled every 60 s whatever is chosen there.
- Step 7 intro: "the AI tool that will read your mail".
- Access summary (step 8, agent page): "Can read; can't change or send anything · … writes need your approval"
  contradicts itself.
- Step 8/listener copy doesn't say calendar invitations don't wake the agent by default (needs `--types`).
- Overview/Approvals tile say "1 message" for a calendar approval (`src/components/overview/attention.tsx:58`).
- Toasts still Gmail-only: "Mail starts syncing now." (`connect-host.tsx:412`, `accounts.tsx:30`), "Your agents can
  use Gmail now." (`get-started.tsx:91`).
- `list_calendar_events` requires `time_min`/`time_max`; an agent's first bare call fails.
- Sidebar: "Gmail for your agents", "Gmail accounts".
- Persona walks: headless shell needs a font (`FONTCONFIG_FILE`) or every screen renders blank.

### Upgrade walk (Wynn, from nightly.34)
- Console/Overview rows say "Delivered to <agent>" for events the listener skipped
  (`src/components/events/event-row.tsx:132`); pending Wynn's call (show "skipped by listener filter").
- Forwards to Hermes-looking URLs changed from `{type,timestamp,data}` to `{type,notice,event}`; route
  prompts/`--script` filters reading fields break silently (docs/listen.md "Upgrading an existing listener" now says
  so).
- The console shows the listener's CLI version but doesn't flag an outdated one.
- The new server's startup log says nothing about the migration or Calendar.
- Wizard final step says "open an agent, then Access → Calendar"; the UI is Mailbox access → Edit → Calendar.
- The Apply toast for a newly created event says it "is updated" (`approval-card.tsx:44`).
- Overview "Mail events" count includes `calendar.event_created`.
- The listener's "Access changed" note after `calendar.read` doesn't say calendar events need `--types`.
- Agent page shows "Last used 26 seconds ago" next to "Not called yet": the listener's key use counts as "used".
- `listen hermes` only knows the route names `agentinbox`/`agentinbox-<profile>`; it can't adopt or confine an
  existing custom route.
- The listener's unconfined-route warning only checks `/webhooks/<name>` routes in the current Hermes home;
  `/p/<profile>/webhooks/<name>` routes aren't looked up.
- `listen … --save` while the profile's service runs saves the profile, then stops on the profile lock; the service
  keeps its old settings until `listen service install`.

### #47 walk fixes (review)
- `server/listen/hermes.ts:247`: the debug line includes the JSON parse error text; Node 24 can quote a file snippet, so an unquoted `whsec_…` could leak ~10 chars into the 0600 log (same as `verifyRoute` before). Log only the error name and position.
- `server/listen/options.ts:327`: the "now skipped by default" note fires on every start for any profile on the default (fresh ones too), not only profiles saved before the default.
- `src/components/approvals/pairing.tsx:319`: presets say "No calendar access" while `presetGrant` keeps calendar caps carried over from Custom ("Plus calendar: …" below).
- `server/listen/hermes.ts:252`: the placeholder regex misses `{ __raw__ }` with spaces (only matters if Hermes accepts that).
- `server/listen/admin.ts:81`: `listen status` reads HERMES_HOME from the calling shell, which may differ from the service's.
- `docs/listen.md` Upgrading: says a placeholder-free route "that runs its own --script or fires a cron job" gets no warning; the code needs only the placeholder-free prompt.
- `server/skill/SKILL.md:49` still says Read only covers "get events" (same mail-vs-calendar ambiguity as the old pairing copy).

### #48 launchd bootstrap race (review)
- `bootstrapLaunchd` prints nothing while it waits for launchd to unload the old job (up to 30 s, plus retries); a "waiting for launchd…" line would help.
- No test covers the unload budget expiring ("still loaded and wouldn't unload"), and no listener test covers the new backoff.
- `server/listen/service.ts`: `const why = commandFailure;` is a leftover alias.

### #50 mail attachments
- A valid key can send a 36 MB `/mcp` body even when that agent has no draft or send grant; consider a capability-aware or per-agent concurrency limit.
- Peak memory for a 25 MB send is several copies of the file (~150–200 MB); stream the composer output.
- The 512 KB switch to Gmail's `/upload/` endpoint is a guess (Google doesn't document the JSON `raw` limit); check against real Gmail.
- Workspace accounts can have admin-set or 50 MB limits; the fixed 25 MB cap ignores them.
- `create_draft` doesn't echo the cleaned filenames back to the agent.
- Forwarded original filenames aren't run through the new filename cleaning.
- `formatSize` uses MiB while the 25 MB cap is decimal ("23.8 MB" for a file just over the cap).
- SKILL.md: an empty filename becomes `attachment.<ext>` when the type is known, not `attachment`.
- `uploadTimeout`: a full 25 MB message gets ~161 s (needs ~1.7 Mbit/s upload); slower links report "may have been sent".
- No test for a timeout/status 0 on the `/upload/` path, or a threaded reply/send through multipart end to end.
- `server/mcp/index.ts` keeps its own `bearer` helper; `app.ts` uses the one in `agentapi/auth.ts`.
- A near-25 MB message with lots of `\uXXXX`-escaped non-ASCII body text can exceed the 36 MiB MCP limit (413 instead of the plain-words size error).
- Any valid key gets the 36 MB body limit (read-only agents too); one request peaks at ~250–300 MB and concurrency is unlimited. Limit large bodies to agents with a draft or send grant, or cap concurrent large requests.
- `mime_type` isn't compared with the extension (an `.html` file can be labelled `application/pdf`).
- Look-alike dots (U+FF0E) in filenames pass the blocklist (Gmail's own content check is the backstop).
- `draftFingerprint` doesn't hash attachment bytes, so a same-size swap made in the Gmail UI wouldn't be caught (pre-existing; no agent tool can do it).
