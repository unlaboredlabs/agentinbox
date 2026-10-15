/**
 * Legit: an app notification that wraps user-supplied names in FSI…PDI isolates (what ICU/Android
 * BidiFormatter.unicodeWrap emits) so an Arabic name doesn't reorder the surrounding English.
 * Decision: stripping isolates is harmless to the text (the characters remain, only display ordering
 * hints go), so it is accepted; hiddenContentRemoved = true is noise but tolerable. If the owner prefers,
 * balanced isolate pairs around plain text could be stripped without counting.
 */
import { FSI, PDI, fixture } from "../fixture.ts";

export default fixture({
  subject: "New comment on your post",
  from: { name: "Communo", email: "notify@communo.example" },
  html: `<p>${FSI}ليلى حسن${PDI} commented on your post ${FSI}Weekend hike photos${PDI}: "Beautiful views!"</p>`,
  expect: {
    hidden: true,
    present: [`ليلى حسن commented on your post Weekend hike photos: "Beautiful views!"`],
  },
  decision: "Isolates (U+2066–2069) are stripped and counted even when balanced; accepted as harmless noise.",
});
