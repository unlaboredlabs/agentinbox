/**
 * Legit: links as ESPs actually send them: long click-tracking redirects with encoded targets,
 * underscores, tildes, fragments, &amp; in attributes, parentheses, mailto: and tel:.
 * Expected: every href preserved exactly (parentheses backslash-escaped by markdown), link text
 * intact, hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Your weekend reading list",
  html: `<p>Here's what we picked for you:</p>
<ul>
<li><a href="https://click.e.readly.example/ls/click?upn=u001.Xk_9-aBc~zz&amp;utm_source=sfmc&amp;utm_campaign=wknd_42#top">The long read: tide clocks</a></li>
<li><a href="https://links.readly.example/r/?target=https%3A%2F%2Freadly.example%2Fa%2F981%3Fref%3Dmail&amp;sig=8c1f">Ten short stories</a></li>
<li><a href="https://en.wikipedia.example/wiki/Bridge_(card_game)">Bridge (card game)</a></li>
</ul>
<p>Write to <a href="mailto:editors@readly.example?subject=Feedback%20on%20issue%2042">editors@readly.example</a> or call <a href="tel:+1-555-0142">+1 555 0142</a>.</p>`,
  expect: {
    hidden: false,
    links: [
      { text: "The long read: tide clocks", href: "https://click.e.readly.example/ls/click?upn=u001.Xk_9-aBc~zz&utm_source=sfmc&utm_campaign=wknd_42#top" },
      { text: "Ten short stories", href: "https://links.readly.example/r/?target=https%3A%2F%2Freadly.example%2Fa%2F981%3Fref%3Dmail&sig=8c1f" },
      { text: "Bridge (card game)", href: "https://en.wikipedia.example/wiki/Bridge_(card_game)" },
      { text: "editors@readly.example", href: "mailto:editors@readly.example?subject=Feedback%20on%20issue%2042" },
      { text: "+1 555 0142", href: "tel:+1-555-0142" },
    ],
  },
});
