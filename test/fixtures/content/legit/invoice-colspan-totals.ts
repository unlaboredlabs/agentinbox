/**
 * Legit: an invoice whose subtotal/tax/total rows use colspan (as most invoice templates do).
 * tableToMarkdown ignores colspan and pads short rows at the end, so "$1,800.00" lands under "Qty"
 * and the agent misreads the totals.
 * Expected: spanned cells expanded so amounts stay in the Amount column.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Invoice 2026-0412 from Brightline Studio",
  html: `<p>Hi Alex, here is invoice 2026-0412 for October.</p>
<table border="1" cellpadding="4">
<tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>
<tr><td>Design sprint</td><td>3</td><td>$500.00</td><td>$1,500.00</td></tr>
<tr><td>Illustrations</td><td>2</td><td>$150.00</td><td>$300.00</td></tr>
<tr><td colspan="3" align="right">Subtotal</td><td>$1,800.00</td></tr>
<tr><td colspan="3" align="right">VAT 20%</td><td>$360.00</td></tr>
<tr><td colspan="3" align="right"><b>Total due</b></td><td><b>$2,160.00</b></td></tr>
</table>
<p>Payment terms: 14 days.</p>`,
  expect: {
    hidden: false,
    present: ["Hi Alex, here is invoice 2026-0412 for October.", "Payment terms: 14 days."],
    tables: [
      "| Description | Qty | Rate | Amount |",
      "| Design sprint | 3 | $500.00 | $1,500.00 |",
      "| Subtotal |  |  | $1,800.00 |",
      "| VAT 20% |  |  | $360.00 |",
      "| **Total due** |  |  | **$2,160.00** |",
    ],
  },
});
