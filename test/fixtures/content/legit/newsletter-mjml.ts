/**
 * Legit: newsletter markup exactly as MJML (the most common email framework) generates it. MJML puts
 * `font-size:0px` on every column <div> and content <td> (to kill inline-block whitespace gaps) and
 * resets the size on the inner text <div>. font-size is inherited and the children override it, so
 * all text is visible. isHiddenByStyle treats font-size:0 as "hide the whole subtree", which deletes
 * the entire email body.
 * Expected: all visible text kept, hiddenContentRemoved = false. Fix: treat font-size like colour
 * (inherited; decide per text node using the nearest explicit size), not like display:none.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "October product update",
  from: { name: "Lumen", email: "news@lumen-app.example" },
  html: `<!doctype html><html><head><title>October product update</title>
<style type="text/css">@media only screen and (min-width:480px){.mj-column-per-100{width:100% !important;max-width:100%;}.mj-column-per-50{width:50% !important;max-width:50%;}}</style></head>
<body style="word-spacing:normal;background-color:#ffffff;">
<div style="background-color:#ffffff;">
<!--[if mso | IE]><table align="center" border="0" cellpadding="0" cellspacing="0" style="width:600px;" width="600"><tr><td style="line-height:0px;font-size:0px;mso-line-height-rule:exactly;"><![endif]-->
<div style="margin:0px auto;max-width:600px;">
<table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;"><tbody><tr>
<td style="direction:ltr;font-size:0px;padding:20px 0;text-align:center;">
<div class="mj-column-per-100 mj-outlook-group-fix" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;">
<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="vertical-align:top;" width="100%"><tbody>
<tr><td align="left" style="font-size:0px;padding:10px 25px;word-break:break-word;"><div style="font-family:Ubuntu, Helvetica, Arial, sans-serif;font-size:22px;line-height:1;text-align:left;color:#000000;">What's new in October</div></td></tr>
<tr><td align="left" style="font-size:0px;padding:10px 25px;word-break:break-word;"><div style="font-family:Ubuntu, Helvetica, Arial, sans-serif;font-size:14px;line-height:1.5;text-align:left;color:#333333;">Shared dashboards are here: invite your whole team to a live view of your metrics.</div></td></tr>
<tr><td align="center" vertical-align="middle" style="font-size:0px;padding:10px 25px;word-break:break-word;">
<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;line-height:100%;"><tr><td align="center" bgcolor="#4f46e5" role="presentation" style="border:none;border-radius:6px;cursor:auto;mso-padding-alt:10px 25px;background:#4f46e5;" valign="middle">
<a href="https://lumen-app.example/dashboards?ref=oct" style="display:inline-block;background:#4f46e5;color:#ffffff;font-family:Ubuntu, Helvetica, Arial, sans-serif;font-size:13px;font-weight:normal;line-height:120%;margin:0;text-decoration:none;text-transform:none;padding:10px 25px;mso-padding-alt:0px;border-radius:6px;" target="_blank">Try shared dashboards</a>
</td></tr></table></td></tr>
</tbody></table></div>
<div class="mj-column-per-50 mj-outlook-group-fix" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;">
<table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tbody>
<tr><td align="left" style="font-size:0px;padding:10px 25px;word-break:break-word;"><div style="font-family:Ubuntu, Helvetica, Arial, sans-serif;font-size:13px;line-height:1.5;text-align:left;color:#555555;">Also new: CSV export for every chart.</div></td></tr>
</tbody></table></div>
</td></tr></tbody></table></div>
<!--[if mso | IE]></td></tr></table><![endif]-->
</div></body></html>`,
  expect: {
    hidden: false,
    present: ["What's new in October", "Shared dashboards are here: invite your whole team to a live view of your metrics.", "Also new: CSV export for every chart."],
    links: [{ text: "Try shared dashboards", href: "https://lumen-app.example/dashboards?ref=oct" }],
  },
});
