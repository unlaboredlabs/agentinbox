/**
 * Legit: transactional email with white-on-blue / white-on-green buttons inside a white page: the
 * button colour set as inline background on the <a>, as `bgcolor` on the button cell (bulletproof
 * button), and via the `background` shorthand. White text on a coloured background is visible.
 * Expected: button labels and hrefs intact, hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Confirm your email address",
  from: { name: "Ledgerly", email: "no-reply@ledgerly.example" },
  html: `<body style="background-color:#ffffff;color:#333333">
<table role="presentation" width="100%" bgcolor="#ffffff"><tr><td style="padding:32px;font-family:Arial">
<p>Welcome to Ledgerly! Please confirm your email address to activate your account.</p>
<p><a href="https://ledgerly.example/confirm?t=9f8e7d" style="background-color:#2563eb;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none">Confirm email</a></p>
<table role="presentation"><tr><td bgcolor="#16a34a" style="border-radius:6px;padding:12px 20px"><a href="https://ledgerly.example/setup" style="color:#ffffff;text-decoration:none"><font color="#ffffff">Set up your workspace</font></a></td></tr></table>
<div style="background:#0f172a;padding:16px"><p style="color:white">Need help? Our team replies within an hour.</p></div>
<p>This link expires in 24 hours.</p>
</td></tr></table></body>`,
  expect: {
    hidden: false,
    present: ["Welcome to Ledgerly! Please confirm your email address to activate your account.", "Need help? Our team replies within an hour.", "This link expires in 24 hours."],
    links: [
      { text: "Confirm email", href: "https://ledgerly.example/confirm?t=9f8e7d" },
      { text: "Set up your workspace", href: "https://ledgerly.example/setup" },
    ],
  },
});
