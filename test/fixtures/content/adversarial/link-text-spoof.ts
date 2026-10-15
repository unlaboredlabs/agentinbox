/**
 * Adversarial: classic phishing link whose visible text is a trusted URL while the href points
 * elsewhere, plus a lookalike-domain button.
 * Expected: markdown keeps the real href next to the deceptive text (the agent can see the mismatch);
 * nothing hidden, hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Unusual sign-in activity",
  html: `<p>We detected an unusual sign-in. Review it at <a href="https://accounts-google.security-check.example/review?id=8812">https://accounts.google.com/review</a>.</p>
<p><a href="https://xn--ggle-0nda.example/verify" style="background:#1a73e8;color:#fff;padding:10px">Secure account</a></p>`,
  expect: {
    hidden: false,
    links: [
      { text: "https://accounts.google.com/review", href: "https://accounts-google.security-check.example/review?id=8812" },
      { text: "Secure account", href: "https://xn--ggle-0nda.example/verify" },
    ],
    suspicious: "none",
  },
});
