/**
 * Legit: a Google Calendar invitation (HTML part) with schema.org microdata, <meta itemprop>, a Meet
 * link, RSVP links and the standard "Forwarding this invitation…" footer (which must not trip the
 * "forward all" regex), plus an invite.ics attachment.
 * Expected: title, time, location, links and footer intact; hiddenContentRemoved = false; no suspicious hits.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Invitation: Design sync @ Tue Oct 20, 2026 2pm - 2:30pm (PDT) (me@acme.test)",
  from: { name: "Google Calendar", email: "calendar-notification@google.com" },
  attachments: [{ id: "att-ics", filename: "invite.ics", mimeType: "application/ics", size: 2210 }],
  html: `<span itemscope itemtype="http://schema.org/InformAction"><span itemprop="object" itemscope itemtype="http://schema.org/Event"><meta itemprop="eventStatus" content="http://schema.org/EventScheduled"><meta itemprop="startDate" content="2026-10-20T21:00:00Z"></span></span>
<table cellspacing="0" cellpadding="8" border="0" role="presentation" style="width:100%"><tr><td>
<h2 style="font-size:22px">Design sync</h2>
<div><b>When</b></div><div>Tuesday Oct 20, 2026 ⋅ 2pm – 2:30pm (Pacific Time - Los Angeles)</div>
<div><b>Joining info</b></div><div><a href="https://meet.google.com/abc-defg-hij?hs=224">Join with Google Meet</a></div><div>meet.google.com/abc-defg-hij</div>
<div><b>Guests</b></div><div><a href="mailto:maya@acme.test">Maya Chen</a> - organizer</div><div><a href="mailto:me@acme.test">me@acme.test</a></div>
<div>Reply for me@acme.test: <a href="https://calendar.google.com/calendar/event?action=RESPOND&amp;eid=MTIz&amp;rst=1&amp;tok=abc">Yes</a> <a href="https://calendar.google.com/calendar/event?action=RESPOND&amp;eid=MTIz&amp;rst=2&amp;tok=abc">No</a> <a href="https://calendar.google.com/calendar/event?action=RESPOND&amp;eid=MTIz&amp;rst=3&amp;tok=abc">Maybe</a></div>
<p style="color:#70757a;font-size:12px">Invitation from Google Calendar. You are receiving this email because you are an attendee on the event. Forwarding this invitation could allow any recipient to send a response to the organizer, be added to the guest list, invite others regardless of their own invitation status, or modify your RSVP.</p>
</td></tr></table>`,
  expect: {
    hidden: false,
    present: [
      "## Design sync",
      "Tuesday Oct 20, 2026 ⋅ 2pm – 2:30pm (Pacific Time - Los Angeles)",
      "meet.google.com/abc-defg-hij",
      "Maya Chen",
      "Forwarding this invitation could allow any recipient to send a response to the organizer",
    ],
    links: [
      { text: "Join with Google Meet", href: "https://meet.google.com/abc-defg-hij?hs=224" },
      { text: "Yes", href: "https://calendar.google.com/calendar/event?action=RESPOND&eid=MTIz&rst=1&tok=abc" },
    ],
  },
});
