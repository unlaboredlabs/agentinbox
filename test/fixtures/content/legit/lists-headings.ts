/**
 * Legit: structured internal update: headings h1–h3, ordered and nested unordered lists, emphasis,
 * a blockquote and a horizontal rule.
 * Expected: faithful markdown structure, hiddenContentRemoved = false, no suspicious hits.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Q4 planning: decisions",
  from: { name: "Maya Chen", email: "maya@acme.test" },
  html: `<h1>Q4 planning</h1>
<p>Here's where we landed after Tuesday's session.</p>
<h2>Decisions</h2>
<ol><li>Ship the <strong>billing revamp</strong> by Nov 20.</li><li>Pause the <em>mobile redesign</em> until January.</li></ol>
<h3>Open questions</h3>
<ul><li>Hiring plan<ul><li>Two backend roles</li><li>One designer</li></ul></li><li>Budget for the offsite</li></ul>
<blockquote>Focus is saying no to good ideas.</blockquote>
<hr>
<p>Comments by Friday please.</p>`,
  expect: {
    hidden: false,
    present: [
      "# Q4 planning",
      "## Decisions",
      "### Open questions",
      "-   Hiring plan\n    -   Two backend roles\n    -   One designer\n-   Budget for the offsite",
      "Ship the **billing revamp** by Nov 20.",
      "Pause the _mobile redesign_ until January.",
      "> Focus is saying no to good ideas.",
      "---",
      "Comments by Friday please.",
    ],
  },
});
