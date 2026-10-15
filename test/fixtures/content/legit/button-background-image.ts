/**
 * Legit: a white-label button whose fill is a `background-image: linear-gradient(...)` (no
 * background-color), inside a white page. cleanTree only reads background-color/background/bgcolor,
 * so it inherits the page's white, sees white-on-white and deletes the button label.
 * Expected: label and link kept, hiddenContentRemoved = false. Fix: an element with a
 * background-image (or `background` containing url()/gradient) makes the background unknown (null).
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Reset your password",
  from: { name: "Orbit", email: "security@orbit-app.example" },
  html: `<body style="background:#ffffff">
<p style="color:#111111">Someone requested a password reset for your Orbit account.</p>
<p><a href="https://orbit-app.example/reset?token=Q2x1ZQ" style="background-image:linear-gradient(135deg,#7c3aed,#2563eb);color:#ffffff;padding:12px 24px;border-radius:8px">Reset password</a></p>
<p style="color:#111111">If you didn't request this, you can ignore this email.</p>
</body>`,
  expect: {
    hidden: false,
    present: ["Someone requested a password reset for your Orbit account.", "If you didn't request this, you can ignore this email."],
    links: [{ text: "Reset password", href: "https://orbit-app.example/reset?token=Q2x1ZQ" }],
  },
  bug: "background-image (gradients) is ignored, so white button text over a gradient on a white page is removed as white-on-white",
});
