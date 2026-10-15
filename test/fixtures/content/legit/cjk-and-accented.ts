/**
 * Legit: Japanese, Simplified Chinese and Korean text, full-width punctuation, plus accented Latin in
 * both precomposed (NFC) and decomposed (NFD, combining U+0301) forms, Vietnamese stacked diacritics
 * and Turkish dotless i.
 * Expected: every character preserved (combining marks are not invisible), hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

const nfd = "Café déjà vu";

export default fixture({
  subject: "会議の確認 / 会议确认 / 회의 확인",
  html: `<p>山田様、明日の会議は午前１０時からです。よろしくお願いいたします。</p>
<p>王先生，明天的会议改到下午三点。</p>
<p>김민수님, 회의 자료를 첨부합니다.</p>
<p>Crème brûlée für Zoë in São Paulo; ${nfd}; Tiếng Việt có dấu; Iğdır ılık.</p>`,
  expect: {
    hidden: false,
    present: [
      "山田様、明日の会議は午前１０時からです。よろしくお願いいたします。",
      "王先生，明天的会议改到下午三点。",
      "김민수님, 회의 자료를 첨부합니다.",
      `Crème brûlée für Zoë in São Paulo; ${nfd}; Tiếng Việt có dấu; Iğdır ılık.`,
    ],
  },
});
