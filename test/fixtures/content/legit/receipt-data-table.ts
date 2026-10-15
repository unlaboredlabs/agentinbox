/**
 * Legit: an order receipt: a data table with <th> headers, prices, quantities, a linked product
 * name and a pipe in a product name, nested inside a presentation layout table.
 * Expected: GFM table with exact cells (pipe escaped, link kept), surrounding text intact,
 * hiddenContentRemoved = false, no suspicious hits.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Your Fieldstone order #FS-30917",
  from: { name: "Fieldstone Outfitters", email: "orders@fieldstone.example" },
  authenticationResults: "mx.google.com; dkim=pass header.i=@fieldstone.example; spf=pass smtp.mailfrom=orders@fieldstone.example; dmarc=pass header.from=fieldstone.example",
  html: `<table role="presentation" width="100%"><tr><td align="center">
<table role="presentation" width="600"><tr><td style="font-family:Arial;color:#333">
<h2>Thanks for your order, Sam!</h2>
<p>Order <b>#FS-30917</b> · placed October 14, 2026</p>
<table cellpadding="6" style="border-collapse:collapse;width:100%">
<thead><tr><th align="left">Item</th><th>Qty</th><th align="right">Price</th></tr></thead>
<tbody>
<tr><td><a href="https://fieldstone.example/p/trail-jacket?variant=moss-m">Trail Jacket (Moss, M)</a></td><td>1</td><td align="right">$189.00</td></tr>
<tr><td>Merino Socks | 3-pack</td><td>2</td><td align="right">$48.00</td></tr>
<tr><td>Shipping</td><td></td><td align="right">$0.00</td></tr>
<tr><td><b>Total</b></td><td></td><td align="right"><b>$237.00</b></td></tr>
</tbody></table>
<p>We'll email you when it ships. Questions? Reply to this email.</p>
</td></tr></table></td></tr></table>`,
  expect: {
    hidden: false,
    present: ["## Thanks for your order, Sam!", "Order **#FS-30917** · placed October 14, 2026", "We'll email you when it ships. Questions? Reply to this email."],
    tables: [
      "| Item | Qty | Price |",
      "| --- | --- | --- |",
      "| [Trail Jacket (Moss, M)](https://fieldstone.example/p/trail-jacket?variant=moss-m) | 1 | $189.00 |",
      "| Merino Socks \\| 3-pack | 2 | $48.00 |",
      "| Shipping |  | $0.00 |",
      "| **Total** |  | **$237.00** |",
    ],
  },
});
