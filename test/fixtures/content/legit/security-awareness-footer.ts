/**
 * Legit: a bank statement notice with the ubiquitous anti-phishing footer "We will never ask you to
 * share your password…". The `(reveal|send|share|…) (your|the) (…passwords?…)` pattern matches the
 * negated sentence, so ordinary bank mail is flagged as instruction-like.
 * Expected: no suspiciousInstructions. Fix: skip matches preceded by a negation
 * (never|not|don't|won't … within ~4 words), or require an imperative at sentence start.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Your e-statement is available",
  from: { name: "Harbor Credit Union", email: "alerts@harborcu.example" },
  html: `<p>Your October e-statement for account ending 4471 is now available in online banking.</p>
<p><a href="https://online.harborcu.example/statements">View statement</a></p>
<p style="font-size:12px;color:#666">Harbor Credit Union will never ask you to share your password, PIN or one-time code by email, text or phone. Never send your credentials to anyone who contacts you.</p>`,
  expect: {
    hidden: false,
    present: ["Your October e-statement for account ending 4471 is now available in online banking.", "Harbor Credit Union will never ask you to share your password, PIN or one-time code"],
    links: [{ text: "View statement", href: "https://online.harborcu.example/statements" }],
  },
});
