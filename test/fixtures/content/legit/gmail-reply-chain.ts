/**
 * Legit: a Gmail reply with a two-level gmail_quote chain, gmail_attr attribution lines and a
 * gmail_signature.
 * Expected: new text first, quoted messages as "> " blockquotes (nested "> >"), attribution and
 * signature intact, mailto links kept, hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Re: Design review",
  from: { name: "Jordan Lee", email: "jordan.lee@gmail.com" },
  html: `<div dir="ltr">Tuesday at 2 works. I'll bring the prototype.<br><br><div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">-- <br>Jordan Lee<br>Product Designer · <a href="https://jordanlee.example">jordanlee.example</a></div></div></div></div><br>
<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, Oct 12, 2026 at 9:14 AM Ada Park &lt;<a href="mailto:ada.park@acme.test">ada.park@acme.test</a>&gt; wrote:<br></div>
<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Can we move the design review to Tuesday?<br><br>Thanks,<br>Ada</div><br>
<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Fri, Oct 9, 2026 at 4:02 PM Jordan Lee &lt;<a href="mailto:jordan.lee@gmail.com">jordan.lee@gmail.com</a>&gt; wrote:<br></div>
<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Design review is booked for Monday 11:00.</div></blockquote></div>
</blockquote></div>`,
  expect: {
    hidden: false,
    present: [
      "Tuesday at 2 works. I'll bring the prototype.",
      "Jordan Lee",
      "On Mon, Oct 12, 2026 at 9:14 AM Ada Park",
      "> Can we move the design review to Tuesday?",
      "> Ada",
      "> > Design review is booked for Monday 11:00.",
    ],
    links: [
      { text: "jordanlee.example", href: "https://jordanlee.example" },
      { text: "ada.park@acme.test", href: "mailto:ada.park@acme.test" },
    ],
  },
});
