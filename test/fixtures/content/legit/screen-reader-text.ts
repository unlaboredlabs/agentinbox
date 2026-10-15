/**
 * Legit: accessibility "screen-reader only" text (1px clipped box), aria-hidden decorative text and
 * a <details> block. Screen-reader text is written for humans using assistive tech.
 * Decision: keep it (it is not hidden from humans, only from sighted ones);
 * hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Your boarding pass",
  from: { name: "Skyline Air", email: "checkin@skyline-air.example" },
  html: `<p>Flight SK 482 · Gate B14 · Boards 09:35</p>
<span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0">Seat 23A, window seat</span>
<p aria-hidden="true">✈ ✈ ✈</p>
<details><summary>Baggage allowance</summary><p>One carry-on up to 8 kg.</p></details>`,
  expect: {
    hidden: false,
    present: ["Flight SK 482 · Gate B14 · Boards 09:35", "Seat 23A, window seat", "✈ ✈ ✈", "Baggage allowance", "One carry-on up to 8 kg."],
  },
  decision: "Screen-reader-only (clipped 1px) text is meant for humans: keep it.",
});
