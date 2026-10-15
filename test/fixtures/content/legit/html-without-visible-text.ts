/**
 * Legit: a message whose HTML part has no visible text at all (only a tracking pixel and empty
 * wrappers, as some ticketing systems send) and whose text/plain part carries the real message.
 * Expected: falls back to text/plain; hiddenContentRemoved = false. Guards the fix proposed in
 * adversarial/html-hidden-text-fallback (only skip the fallback when hidden content was removed).
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Ticket #5521 updated",
  from: { name: "Helpdesk", email: "help@deskly.example" },
  html: `<html><body><div><table role="presentation"><tr><td>&nbsp;</td></tr></table></div><img src="https://deskly.example/px.gif" width="1" height="1" alt=""></body></html>`,
  text: "Your ticket #5521 was updated by Marco: \"We've deployed the fix, please try again.\"",
  expect: {
    hidden: false,
    present: ["Your ticket #5521 was updated by Marco: \"We've deployed the fix, please try again.\""],
  },
});
