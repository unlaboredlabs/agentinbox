/**
 * Legit: a hero banner with white headline text over a photo, set as
 * `background: url('…/white-sand-beach.jpg') center / cover` and, for Outlook, a `background=`
 * attribute. backgroundColor() tokenises the shorthand and treats the word "white" inside the URL as
 * the colour, and ignores the `background` attribute, so the headline is deleted as white-on-white.
 * Expected: headline kept, hiddenContentRemoved = false. Fix: drop url(...) before tokenising and treat
 * any background image (shorthand url(), background-image, background= attribute) as unknown colour.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Your winter escape starts here",
  from: { name: "Seabird Travel", email: "deals@seabird.example" },
  html: `<body style="background-color:#ffffff">
<table role="presentation" width="600" bgcolor="#ffffff"><tr>
<td style="background:url('https://cdn.seabird.example/hero/white-sand-beach.jpg') center / cover no-repeat;padding:80px 24px;color:#ffffff">
<h1 style="color:#ffffff">Seven nights in Zanzibar from $1,299</h1></td></tr>
<tr><td background="https://cdn.seabird.example/hero/lagoon.jpg" style="padding:40px 24px"><p style="color:#ffffff">Flights and transfers included.</p></td></tr>
<tr><td style="color:#333333;padding:24px"><p>Offer ends Sunday. <a href="https://seabird.example/deals/zanzibar?src=email">See dates</a></p></td></tr>
</table></body>`,
  expect: {
    hidden: false,
    present: ["# Seven nights in Zanzibar from $1,299", "Flights and transfers included.", "Offer ends Sunday."],
    links: [{ text: "See dates", href: "https://seabird.example/deals/zanzibar?src=email" }],
  },
  bug: "colour words inside url() in the background shorthand are read as the background colour, and background images are ignored (white headline on a photo removed)",
});
