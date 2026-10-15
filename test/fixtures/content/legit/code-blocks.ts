/**
 * Legit: a developer email with a <pre><code> block containing HTML-looking text and angle brackets,
 * inline <code>, and a monospace span (Gmail's "Fixed width" font).
 * Expected: fenced code block with the code verbatim (including `<div>` text), inline code kept,
 * hiddenContentRemoved = false. Tag-leak check is skipped: the visible text contains tag-like code.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Fix for the null check",
  from: { name: "Sam Ortiz", email: "sam@acme.test" },
  html: `<p>The bug is in <code>render_header()</code>, which compares before the null check:</p>
<pre><code>if (user &amp;&amp; user.age &lt; 18) {
  return "&lt;div class=\\"minor\\"&gt;" + user.name + "&lt;/div&gt;";
}</code></pre>
<p>Run it with <span style="font-family:monospace,monospace">NODE_ENV=test pnpm vitest</span> to reproduce.</p>`,
  expect: {
    hidden: false,
    allowTags: true,
    present: [
      "The bug is in `render_header()`, which compares before the null check:",
      '```\nif (user && user.age < 18) {\n  return "<div class=\\"minor\\">" + user.name + "</div>";\n}\n```',
      "to reproduce.",
    ],
  },
});
