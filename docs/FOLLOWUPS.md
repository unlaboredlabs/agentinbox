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
