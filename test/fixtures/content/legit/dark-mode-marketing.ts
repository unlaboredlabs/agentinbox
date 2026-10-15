/**
 * Legit: marketing email with dark-mode support: <meta name="color-scheme">, a
 * prefers-color-scheme media query that swaps colours via classes, inline light-mode colours, and a
 * dark-mode logo swap (inline display:none image without text, revealed by the media query).
 * Expected: all visible copy intact; the dark-logo <img> has no text so removing it is not "hidden
 * content": hiddenContentRemoved = false; no suspicious hits.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Autumn collection: 20% off this weekend",
  from: { name: "Northbound", email: "shop@northbound.example" },
  html: `<!DOCTYPE html><html><head>
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<style>
:root { color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  .bg { background-color: #121212 !important; }
  .fg { color: #f1f1f1 !important; }
  .light-logo { display: none !important; }
  .dark-logo { display: block !important; }
}
</style></head>
<body class="bg" style="background-color:#ffffff;margin:0">
<table role="presentation" width="100%" class="bg" style="background-color:#ffffff"><tr><td class="fg" style="color:#1d1d1f;padding:24px;font-family:-apple-system,Helvetica,sans-serif">
<img class="light-logo" src="https://cdn.northbound.example/logo-dark-ink.png" alt="Northbound" width="120">
<img class="dark-logo" src="https://cdn.northbound.example/logo-light-ink.png" alt="" width="120" style="display:none;mso-hide:all">
<h1 class="fg" style="color:#1d1d1f">Autumn collection is here</h1>
<p class="fg" style="color:#1d1d1f">Wool layers, waxed jackets and boots built for wet trails. Take 20% off everything this weekend with code <b>FALL20</b>.</p>
<p><a href="https://northbound.example/autumn?utm_source=email&amp;utm_campaign=fall20" style="color:#0a84ff">Shop the collection</a></p>
</td></tr></table></body></html>`,
  expect: {
    hidden: false,
    present: ["# Autumn collection is here", "Take 20% off everything this weekend with code **FALL20**.", "![Northbound](https://cdn.northbound.example/logo-dark-ink.png)"],
    links: [{ text: "Shop the collection", href: "https://northbound.example/autumn?utm_source=email&utm_campaign=fall20" }],
    absent: ["logo-light-ink.png", "prefers-color-scheme"],
  },
});
