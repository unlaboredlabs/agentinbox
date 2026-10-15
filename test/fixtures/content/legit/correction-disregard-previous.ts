/**
 * Legit: a logistics correction ("Please disregard the previous instructions about parking"). This
 * is ordinary office English that is literally the canonical injection phrase.
 * Decision: an accepted overlap. The hit is informational and content is untouched, so the signal
 * firing here is acceptable; narrowing the regex to avoid it would also miss real attacks.
 * Expected: text intact, suspiciousInstructions contains the phrase, hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Correction: offsite parking",
  from: { name: "Office Manager", email: "office@acme.test" },
  html: `<p>Hi all,</p><p>Please disregard the previous instructions about parking. The garage on 5th is closed; use the lot behind building C instead.</p><p>Thanks, Rosa</p>`,
  expect: {
    hidden: false,
    present: ["Please disregard the previous instructions about parking. The garage on 5th is closed; use the lot behind building C instead."],
    suspicious: ["disregard the previous instructions"],
  },
  decision: "\"Disregard the previous instructions\" in a genuine correction is an accepted, informational overlap.",
});
