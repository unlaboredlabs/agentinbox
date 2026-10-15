/**
 * Legit: a classic hand-coded table newsletter: role=presentation layout tables, Outlook conditional
 * comments (incl. downlevel-revealed `<!--[if !mso]><!-->`), a display:none preheader padded with
 * &zwnj;&nbsp; (invisible by design, so removing it is correct), headings, images, UTM links, footer.
 * Expected: every visible block intact and in order, no layout pipes, links exact;
 * hiddenContentRemoved = true (only because of the preheader); no suspicious hits.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "The Weekly Build #112: edge caching, Postgres 18 and more",
  from: { name: "The Weekly Build", email: "hello@weeklybuild.example" },
  html: `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>The Weekly Build #112</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>body{margin:0;padding:0} .footer a{color:#888888}</style></head>
<body style="margin:0;padding:0;background-color:#f4f4f4">
<div style="display:none;font-size:1px;color:#f4f4f4;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Edge caching patterns, what's new in Postgres 18, and a job board refresh.&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f4"><tr><td align="center">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" style="max-width:600px" cellpadding="0" cellspacing="0" bgcolor="#ffffff">
<tr><td style="padding:24px 32px"><img src="https://cdn.weeklybuild.example/logo.png" width="140" height="32" alt="The Weekly Build"></td></tr>
<tr><td style="padding:0 32px;color:#222222;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px">
<h1 style="font-size:24px;margin:0 0 12px">Issue #112</h1>
<p>Hi there, this week we dig into caching at the edge and the Postgres 18 release.</p>
<h2 style="font-size:18px">Edge caching without tears</h2>
<p>Stale-while-revalidate is the default you probably want. <a href="https://weeklybuild.example/r/edge-caching?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=112">Read the article</a> (8 min).</p>
<h2 style="font-size:18px">Postgres 18 is out</h2>
<p>Async I/O, virtual generated columns and faster upgrades. <a href="https://weeklybuild.example/r/pg18?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=112">Release notes</a>.</p>
<!--[if !mso]><!--><p>Prefer the web? <a href="https://weeklybuild.example/issues/112">Read this issue online</a>.</p><!--<![endif]-->
</td></tr>
<tr><td class="footer" style="padding:24px 32px;color:#888888;font-size:12px;font-family:Helvetica,Arial,sans-serif">
<p>You're receiving this because you subscribed at weeklybuild.example.</p>
<p><a href="https://weeklybuild.example/unsubscribe?u=4f9c2&amp;list=main">Unsubscribe</a> · <a href="https://weeklybuild.example/prefs?u=4f9c2">Preferences</a></p>
<p>The Weekly Build, 548 Market St #1234, San Francisco, CA 94104</p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
<img src="https://t.weeklybuild.example/open?u=4f9c2&amp;i=112" width="1" height="1" alt="" style="display:block">
</body></html>`,
  expect: {
    hidden: true,
    absent: ["Edge caching patterns, what's new", "t.weeklybuild.example/open", "OfficeDocumentSettings"],
    present: [
      "![The Weekly Build](https://cdn.weeklybuild.example/logo.png)",
      "# Issue #112",
      "Hi there, this week we dig into caching at the edge and the Postgres 18 release.",
      "## Edge caching without tears",
      "Stale-while-revalidate is the default you probably want.",
      "## Postgres 18 is out",
      "Async I/O, virtual generated columns and faster upgrades.",
      "Prefer the web?",
      "You're receiving this because you subscribed at weeklybuild.example.",
      "The Weekly Build, 548 Market St #1234, San Francisco, CA 94104",
    ],
    links: [
      { text: "Read the article", href: "https://weeklybuild.example/r/edge-caching?utm_source=newsletter&utm_medium=email&utm_campaign=112" },
      { text: "Release notes", href: "https://weeklybuild.example/r/pg18?utm_source=newsletter&utm_medium=email&utm_campaign=112" },
      { text: "Read this issue online", href: "https://weeklybuild.example/issues/112" },
      { text: "Unsubscribe", href: "https://weeklybuild.example/unsubscribe?u=4f9c2&list=main" },
      { text: "Preferences", href: "https://weeklybuild.example/prefs?u=4f9c2" },
    ],
  },
  decision: "A display:none preheader is invisible by design: removing it and setting hiddenContentRemoved is correct.",
});
