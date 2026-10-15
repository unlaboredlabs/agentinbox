/**
 * Legit: responsive email with class-based show/hide: `.mobile-only{display:none}` at top level,
 * revealed by `@media (max-width:600px)`; `.desktop-only` hidden only inside the media query; and an
 * Outlook-only `mso-hide:all` block (visible everywhere but Outlook).
 * Expected: all text kept today (the cleaner ignores <style>); this guards a future class-hiding fix
 * (adversarial/css-class-hiding) from deleting content a @media rule reveals.
 * hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Your ride receipt",
  from: { name: "Zippy Rides", email: "receipts@zippy.example" },
  html: `<html><head><style>
.mobile-only { display: none; max-height: 0; overflow: hidden; }
@media only screen and (max-width: 600px) {
  .mobile-only { display: block !important; max-height: none !important; }
  .desktop-only { display: none !important; }
}
</style></head><body>
<p>Thanks for riding with Zippy. Total: €14.20.</p>
<div class="desktop-only"><p>Trip map and full breakdown are below.</p></div>
<div class="mobile-only"><p>Tap to open the trip in the app.</p></div>
<div style="mso-hide:all"><p>Rate your driver in one tap.</p></div>
</body></html>`,
  expect: {
    hidden: false,
    present: ["Thanks for riding with Zippy. Total: €14.20.", "Trip map and full breakdown are below.", "Tap to open the trip in the app.", "Rate your driver in one tap."],
  },
  decision: "Content hidden by a top-level class but revealed by a @media rule is visible on some device: keep it.",
});
