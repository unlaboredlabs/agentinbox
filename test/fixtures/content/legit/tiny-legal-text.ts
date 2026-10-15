/**
 * Legit: tiny but visible legal print: font-size 1px (the spec's example of "visible, keep"), 8px grey
 * disclaimer, and 0.6em footnote.
 * Expected: all kept, hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Your loan pre-approval",
  from: { name: "Keystone Lending", email: "notices@keystone-lending.example" },
  html: `<p>Good news! You're pre-approved for up to $25,000.</p>
<p style="font-size:8px;color:#888888">Pre-approval is not a commitment to lend. Rates from 7.9% APR with autopay.</p>
<p style="font-size:1px;line-height:1px;color:#999999">Keystone Lending NMLS #48210. Equal Housing Lender.</p>
<p style="font-size:0.6em">*Subject to credit review.</p>`,
  expect: {
    hidden: false,
    present: [
      "Good news! You're pre-approved for up to $25,000.",
      "Pre-approval is not a commitment to lend. Rates from 7.9% APR with autopay.",
      "Keystone Lending NMLS #48210. Equal Housing Lender.",
      "Subject to credit review.",
    ],
  },
  decision: "Tiny-but-nonzero text (1px and up) is visible and kept.",
});
