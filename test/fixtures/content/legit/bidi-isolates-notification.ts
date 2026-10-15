/**
 * Legit: an app notification that wraps user-supplied names in FSI…PDI isolates (what ICU/Android
 * BidiFormatter.unicodeWrap emits) so an Arabic name doesn't reorder the surrounding English.
 * Decision: isolates are stripped (only display-ordering hints go; the characters remain). Balanced
 * FSI…PDI pairs are stripped silently; only unbalanced ones count as hidden content.
 */
import { FSI, PDI, fixture } from "../fixture.ts";

export default fixture({
  subject: "New comment on your post",
  from: { name: "Communo", email: "notify@communo.example" },
  html: `<p>${FSI}ليلى حسن${PDI} commented on your post ${FSI}Weekend hike photos${PDI}: "Beautiful views!"</p>`,
  expect: {
    hidden: false,
    present: [`ليلى حسن commented on your post Weekend hike photos: "Beautiful views!"`],
  },
  decision: "Isolates (U+2066–2069) are stripped; balanced pairs silently, unbalanced ones flagged.",
});
