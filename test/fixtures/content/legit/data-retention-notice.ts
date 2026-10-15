/**
 * Legit: a workspace retention-policy notice ("we will delete all messages older than 90 days"),
 * a common SaaS/IT email. The `(delete|trash) (all|every) (emails?|messages)` pattern flags it.
 * Expected: no suspiciousInstructions. Fix: only match second-person imperatives at the start of a
 * sentence/line (e.g. ^\s*(?:please\s+)?(?:delete|trash)\s+all…), not "we will delete all messages".
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Changes to message history on the Free plan",
  from: { name: "Chatterbox", email: "feedback@chatterbox.example" },
  html: `<p>Hi there,</p>
<p>Starting November 26, 2026, workspaces on the Free plan will keep 90 days of history. After that date, we will delete all messages and files older than 90 days.</p>
<p>To keep your full history, <a href="https://chatterbox.example/pricing?ref=retention">upgrade to Pro</a> or <a href="https://chatterbox.example/help/export">export your data</a>.</p>`,
  expect: {
    hidden: false,
    present: ["After that date, we will delete all messages and files older than 90 days."],
    links: [{ text: "upgrade to Pro", href: "https://chatterbox.example/pricing?ref=retention" }],
  },
});
