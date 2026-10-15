/**
 * Legit: Hebrew and Arabic order confirmations with legitimate bidi *marks*: RLM/LRM (U+200F/U+200E)
 * around numbers and Latin product codes, and the Arabic letter mark (U+061C). Marks are not
 * overrides; they carry no hidden text and are needed for correct display of mixed-direction runs.
 * Expected: text and marks preserved byte-for-byte, hiddenContentRemoved = false.
 */
import { ALM, LRM, RLM, fixture } from "../fixture.ts";

export default fixture({
  subject: "אישור הזמנה 48213",
  html: `<div dir="rtl" style="text-align:right">
<p>שלום דנה,</p>
<p>ההזמנה שלך מספר 48213${RLM} התקבלה. המוצר USB-C${LRM} hub${LRM} יישלח מחר.</p>
<p>مرحباً سارة، تم شحن طلبك رقم 7731${ALM} وسيصل خلال ٣ أيام.</p>
<p>${RLM}לשאלות: <a href="https://shop.example.co.il/help">מרכז העזרה</a></p>
</div>`,
  expect: {
    hidden: false,
    present: [
      "שלום דנה,",
      `ההזמנה שלך מספר 48213${RLM} התקבלה. המוצר USB-C${LRM} hub${LRM} יישלח מחר.`,
      `مرحباً سارة، تم شحن طلبك رقم 7731${ALM} وسيصل خلال ٣ أيام.`,
    ],
    links: [{ text: "מרכז העזרה", href: "https://shop.example.co.il/help" }],
  },
  decision: "RLM/LRM/ALM are marks, not overrides: keep them and do not count them as hidden.",
});
