/**
 * Legit: Outlook desktop (Word HTML) reply: MsoNormal paragraphs, <o:p>, a Word list with
 * `<![if !supportLists]>` bogus comments and `font:7.0pt "Times New Roman"` / negative text-indent
 * (both legit, must not be mistaken for hiding), a coloured signature and the From/Sent/To/Subject
 * header block separated by a border-top div.
 * Expected: all visible text intact, no Word markup leaking, hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "RE: Vendor onboarding checklist",
  from: { name: "Greg Hollis", email: "greg.hollis@contoso.example" },
  html: `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style><!-- p.MsoNormal{margin:0in;font-size:11.0pt;font-family:"Calibri",sans-serif;} --></style></head>
<body lang="EN-US" link="#0563C1" vlink="#954F72"><div class="WordSection1">
<p class="MsoNormal">Hi Priya,<o:p></o:p></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal">Two things are still missing:<o:p></o:p></p>
<p class="MsoListParagraph" style="text-indent:-.25in;mso-list:l0 level1 lfo1"><![if !supportLists]><span style="font-family:Symbol"><span style="mso-list:Ignore">·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>Signed W-9 form<o:p></o:p></p>
<p class="MsoListParagraph" style="text-indent:-.25in;mso-list:l0 level1 lfo1"><![if !supportLists]><span style="font-family:Symbol"><span style="mso-list:Ignore">·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>Bank verification letter<o:p></o:p></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal"><span style="color:#1F497D">Greg Hollis | Procurement | Contoso Ltd.<o:p></o:p></span></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">
<p class="MsoNormal"><b>From:</b> Priya Nair &lt;priya@acme.test&gt; <br><b>Sent:</b> Monday, October 12, 2026 10:03 AM<br><b>To:</b> Greg Hollis &lt;greg.hollis@contoso.example&gt;<br><b>Subject:</b> Vendor onboarding checklist<o:p></o:p></p></div></div>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal">Hi Greg, what else do you need from us to finish onboarding?<o:p></o:p></p>
</div></body></html>`,
  expect: {
    hidden: false,
    present: [
      "Hi Priya,",
      "Two things are still missing:",
      "Signed W-9 form",
      "Bank verification letter",
      "Greg Hollis | Procurement | Contoso Ltd.",
      "**From:** Priya Nair <priya@acme.test>",
      "**Sent:** Monday, October 12, 2026 10:03 AM",
      "**Subject:** Vendor onboarding checklist",
      "Hi Greg, what else do you need from us to finish onboarding?",
    ],
    absent: ["MsoNormal", "supportLists", "mso-list"],
  },
});
