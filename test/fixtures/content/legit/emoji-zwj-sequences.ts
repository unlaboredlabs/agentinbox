/**
 * Legit: emoji ZWJ sequences without skin-tone modifiers: family, rainbow and transgender flags,
 * pirate flag, heart on fire, woman with red hair, eye in speech bubble; plus a standalone VS16.
 * Expected: every sequence byte-identical (ZWJ and VS16 kept), hiddenContentRemoved = false.
 */
import { ZWJ, ch, fixture } from "../fixture.ts";

const family = `${ch(0x1f468)}${ZWJ}${ch(0x1f469)}${ZWJ}${ch(0x1f467)}`;
const rainbow = `${ch(0x1f3f3, 0xfe0f)}${ZWJ}${ch(0x1f308)}`;
const trans = `${ch(0x1f3f3, 0xfe0f)}${ZWJ}${ch(0x26a7, 0xfe0f)}`;
const pirate = `${ch(0x1f3f4)}${ZWJ}${ch(0x2620, 0xfe0f)}`;
const heartFire = `${ch(0x2764, 0xfe0f)}${ZWJ}${ch(0x1f525)}`;
const redHair = `${ch(0x1f469)}${ZWJ}${ch(0x1f9b0)}`;
const eyeBubble = `${ch(0x1f441, 0xfe0f)}${ZWJ}${ch(0x1f5e8, 0xfe0f)}`;
const heart = ch(0x2764, 0xfe0f);

export default fixture({
  subject: `Family photos ${family}`,
  html: `<p>Family reunion photos are up ${family}! Pride parade pics too ${rainbow} ${trans}.</p>
<p>Kids' pirate party ${pirate}, the bonfire ${heartFire}, Aunt May ${redHair}, and the magician ${eyeBubble}.</p>
<p>Love you all ${heart}</p>`,
  expect: {
    hidden: false,
    present: [
      `Family reunion photos are up ${family}! Pride parade pics too ${rainbow} ${trans}.`,
      `Kids' pirate party ${pirate}, the bonfire ${heartFire}, Aunt May ${redHair}, and the magician ${eyeBubble}.`,
      `Love you all ${heart}`,
    ],
  },
});
