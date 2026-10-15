/**
 * Adversarial: javascript: hrefs obfuscated with a tab / newline inside the scheme (`java&#09;script:`).
 * Browsers strip ASCII tab/newline from URLs, so these execute; the unsafeLinks rule's
 * /^(javascript|data|vbscript):/ does not match them, so the link survives into the markdown
 * (a problem for any UI that renders the agent's markdown).
 * Expected: hrefs dropped, link text kept.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Document ready",
  html: `<p>Your document is ready: <a href="java&#09;script:alert(document.domain)">Open document</a></p>
<p><a href="jav&#x0A;ascript:alert(2)">Download</a></p>`,
  expect: {
    absent: ["script:alert"],
    present: ["Open document", "Download"],
  },
  bug: "unsafeLinks misses schemes containing tab/newline (java\\tscript:); strip [\\t\\n\\r] (and control chars) before testing the scheme",
});
