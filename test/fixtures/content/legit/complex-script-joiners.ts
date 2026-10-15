/**
 * Legit: Persian and Indic text where ZWNJ (U+200C) and ZWJ (U+200D) are orthographic: Persian
 * "می‌خواهم" (I want) and "کتاب‌ها" (books) need ZWNJ to keep the prefix/suffix unjoined; Hindi and
 * Malayalam use ZWJ/ZWNJ to select conjunct/half forms. stripInvisible removes both (only emoji ZWJ is
 * spared), misspelling every such word and setting hiddenContentRemoved on every Persian email.
 * Expected: text byte-identical, hiddenContentRemoved = false. Fix: keep U+200C/U+200D between two
 * letters (\p{L}\p{M}*) of scripts that use them (Arabic, Syriac, Indic, Sinhala); they cannot carry
 * smuggled ASCII there.
 */
import { ZWJ, ZWNJ, fixture } from "../fixture.ts";

const persian = `سلام علی، من می${ZWNJ}خواهم کتاب${ZWNJ}ها را تا جمعه برگردانم.`;
const hindi = `क्${ZWJ}ष और क्${ZWNJ}ष दोनों रूप सही हैं।`;
const malayalam = `ന്${ZWJ} ചില്ല് അക്ഷരം`;

export default fixture({
  subject: "کتاب‌های کتابخانه",
  html: `<p dir="rtl">${persian}</p><p>${hindi}</p><p>${malayalam}</p>`,
  expect: {
    hidden: false,
    present: [persian, hindi, malayalam],
  },
  bug: "stripInvisible removes orthographic ZWNJ/ZWJ in Persian and Indic scripts (misspells words, sets hiddenContentRemoved)",
});
