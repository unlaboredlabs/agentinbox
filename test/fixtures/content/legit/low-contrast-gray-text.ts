/**
 * Legit: low-contrast but readable text that a contrast-threshold heuristic must keep: #eeeeee on
 * white (contrast 1.16), #cccccc on white, #333 on #222, and light-grey "unsubscribe" footer.
 * Pins the boundary proposed in adversarial/color-near-identical (hide below contrast 1.1 only).
 * Expected: all kept, hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Watermarked draft",
  html: `<body style="background:#ffffff">
<p>Attached is the draft agreement.</p>
<p style="color:#eeeeee">DRAFT - NOT FOR DISTRIBUTION</p>
<p style="color:#cccccc">Sent from the Acme document portal</p>
<div style="background:#222222"><p style="color:#333333">Dark footer caption</p></div>
</body>`,
  expect: {
    hidden: false,
    present: ["Attached is the draft agreement.", "DRAFT - NOT FOR DISTRIBUTION", "Sent from the Acme document portal", "Dark footer caption"],
  },
  decision: "Same-colour boundary: contrast >= 1.1 is visible (keep #eeeeee on white).",
});
