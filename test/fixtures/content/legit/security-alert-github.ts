/**
 * Legit: GitHub security notifications in text/plain: a device-verification code and a new SSH key
 * notice, using the standard "If you didn't do this, ignore this email" / "please ignore this email"
 * phrasing and "Don't share this code".
 * Expected: text intact; no suspiciousInstructions; hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "[GitHub] Please verify your device",
  from: { name: "GitHub", email: "noreply@github.com" },
  text: `Hey octo-dev!

A sign in attempt requires further verification because we did not recognize your device. To complete the sign in, enter the verification code on the unrecognized device.

Device: Chrome on macOS
Verification code: 482913

If you did not attempt to sign in to your account, your password may be compromised. Visit https://github.com/settings/security to create a new, strong password for your GitHub account.

Don't share this code with anyone. If you didn't do this, ignore this email.

Thanks,
The GitHub Team`,
  expect: {
    hidden: false,
    present: [
      "Verification code: 482913",
      "Visit https://github.com/settings/security to create a new, strong password for your GitHub account.",
      "Don't share this code with anyone. If you didn't do this, ignore this email.",
    ],
  },
});
