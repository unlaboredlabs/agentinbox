/**
 * Legit: a support-ticket / bug-report email with a diagnostics block ("System: macOS 15.1"). The
 * line-start `^\s*(?:assistant|system)\s*:` pattern flags every such key/value line.
 * Expected: no suspiciousInstructions. Fix: require chat-transcript shape (role label followed by
 * prose/imperative, or lower-case role tags like `system:` at the start of the body), or drop the
 * bare `System:` alternative and keep <|im_start|>/[system]/<system>.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "[Ticket #20817] App crashes when exporting PDF",
  from: { name: "Support", email: "support@pixelpress.example" },
  text: `A new ticket was submitted.

Customer: Lena Fischer
Subject: App crashes when exporting PDF

Description:
The app closes as soon as I click Export > PDF on any document over 20 pages.

Diagnostics
App version: 4.12.1 (build 9921)
System: macOS 15.1 (24B83)
Memory: 16 GB

View ticket: https://support.pixelpress.example/t/20817`,
  expect: {
    hidden: false,
    present: ["The app closes as soon as I click Export > PDF on any document over 20 pages.", "System: macOS 15.1 (24B83)"],
  },
  bug: "suspiciousInstructions false positive on a diagnostics line \"System: macOS 15.1\"",
});
