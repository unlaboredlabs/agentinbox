/**
 * Legit: a text/plain-only personal email with an inline reply, "> " quoting, bare URLs, a tab-aligned
 * list, an ASCII table and a "-- " signature.
 * Expected: text intact (only CRLF and trailing-space normalisation), hiddenContentRemoved = false.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Re: cabin weekend",
  from: { name: "Rui", email: "rui.almeida@gmail.com" },
  text: `Sounds great! Answers inline.\r
\r
> Can you bring the board games?\r
Yes, Catan and Codenames.\r
\r
> What time do we leave?\r
Around 9. Directions: https://maps.example/?q=Pine+Cabin&z=12\r
\r
Packing:\r
\t- sleeping bag\r
\t- headlamp\r
\r
+-------+--------+\r
| Day   | Cook   |\r
+-------+--------+\r
| Sat   | Rui    |\r
+-------+--------+\r
\r
-- \r
Rui`,
  expect: {
    hidden: false,
    present: [
      "> Can you bring the board games?\nYes, Catan and Codenames.",
      "Around 9. Directions: https://maps.example/?q=Pine+Cabin&z=12",
      "\t- sleeping bag\n\t- headlamp",
      "| Day   | Cook   |",
      "--\nRui",
    ],
  },
});
