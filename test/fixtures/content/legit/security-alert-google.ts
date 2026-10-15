/**
 * Legit: a Google "new sign-in" security alert, with its standard reassurance ("If this was you, you
 * don't need to do anything") and a white-on-blue "Check activity" button.
 * Expected: all text and the button link intact; no suspiciousInstructions (this is not an injection);
 * hiddenContentRemoved = false; auth all pass, so no signal line beyond "external sender".
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Security alert",
  from: { name: "Google", email: "no-reply@accounts.google.com" },
  authenticationResults: "mx.google.com; dkim=pass header.i=@accounts.google.com; spf=pass smtp.mailfrom=no-reply@accounts.google.com; dmarc=pass (p=REJECT) header.from=accounts.google.com",
  html: `<table role="presentation" width="100%" style="background:#ffffff"><tr><td align="center">
<div style="border:thin solid #dadce0;border-radius:8px;padding:40px 20px;max-width:516px">
<img src="https://www.gstatic.com/images/branding/googlelogo/2x/googlelogo_color_74x24dp.png" width="74" height="24" alt="Google">
<div style="font-size:24px;color:#202124">A new sign-in on Mac</div>
<div style="font-size:14px;color:#3c4043">me@acme.test</div>
<div style="font-size:14px;color:#3c4043;line-height:20px">We noticed a new sign-in to your Google Account on a Mac device. If this was you, you don't need to do anything. If not, we'll help you secure your account.</div>
<div style="padding-top:32px;text-align:center"><a href="https://accounts.google.com/AccountChooser?Email=me@acme.test&amp;continue=https://myaccount.google.com/alert/nt/1729?rfn%3D127" style="background-color:#4184f3;border-radius:5px;color:#ffffff;display:inline-block;font-size:14px;font-weight:400;line-height:36px;padding:0 24px;text-decoration:none">Check activity</a></div>
<div style="padding-top:20px;font-size:12px;color:#5f6368">You can also see security activity at<br><a href="https://myaccount.google.com/notifications" style="color:rgba(0,0,0,0.87)">https://myaccount.google.com/notifications</a></div>
</div>
<div style="font-size:11px;color:rgba(0,0,0,0.54);line-height:18px;padding-top:12px">You received this email to let you know about important changes to your Google Account and services.<br>© 2026 Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043, USA</div>
</td></tr></table>`,
  expect: {
    hidden: false,
    present: [
      "A new sign-in on Mac",
      "If this was you, you don't need to do anything. If not, we'll help you secure your account.",
      "You received this email to let you know about important changes to your Google Account and services.",
    ],
    links: [
      { text: "Check activity", href: "https://accounts.google.com/AccountChooser?Email=me@acme.test&continue=https://myaccount.google.com/alert/nt/1729?rfn%3D127" },
      { text: "https://myaccount.google.com/notifications", href: "https://myaccount.google.com/notifications" },
    ],
  },
});
