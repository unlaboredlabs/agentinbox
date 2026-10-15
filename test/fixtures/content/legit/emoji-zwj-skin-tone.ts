/**
 * Legit: emoji ZWJ sequences that include a skin-tone modifier before the ZWJ (woman technologist
 * medium skin tone, woman running light skin tone, people holding hands with two tones). EMOJI_ZWJ in
 * content.ts requires \p{Extended_Pictographic} right before the ZWJ, but modifiers (U+1F3FB–1F3FF) are
 * Emoji_Component, so the ZWJ is stripped: each emoji splits in two and hiddenContentRemoved flips on.
 * Expected: sequences byte-identical, hiddenContentRemoved = false. Fix: allow
 * (?:\p{Emoji_Modifier}|️)? before the ZWJ, or match whole RGI_Emoji sequences with the /v flag.
 */
import { ZWJ, ch, fixture } from "../fixture.ts";

const technologist = `${ch(0x1f469, 0x1f3fd)}${ZWJ}${ch(0x1f4bb)}`;
const runner = `${ch(0x1f3c3, 0x1f3fb)}${ZWJ}${ch(0x2640, 0xfe0f)}`;
const holding = `${ch(0x1f9d1, 0x1f3ff)}${ZWJ}${ch(0x1f91d)}${ZWJ}${ch(0x1f9d1, 0x1f3fb)}`;

export default fixture({
  subject: "Hackathon team",
  html: `<p>Our hackathon team ${technologist} ${technologist} is ready!</p><p>Morning run club ${runner} meets at 7.</p><p>Mentoring pairs ${holding} announced Friday.</p>`,
  expect: {
    hidden: false,
    present: [`Our hackathon team ${technologist} ${technologist} is ready!`, `Morning run club ${runner} meets at 7.`, `Mentoring pairs ${holding} announced Friday.`],
  },
});
