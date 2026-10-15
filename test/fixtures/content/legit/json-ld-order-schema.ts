/**
 * Legit: a shipping notification carrying Gmail's schema.org JSON-LD markup in a
 * <script type="application/ld+json"> block (how Gmail shows order/tracking cards).
 * Expected: the script is removed silently: hiddenContentRemoved = false (guards the script-counting
 * fix proposed in adversarial/script-template-noscript); visible text and tracking link intact.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Your package is on the way",
  from: { name: "Parcelly", email: "track@parcelly.example" },
  html: `<html><head><script type="application/ld+json">
{"@context":"http://schema.org","@type":"ParcelDelivery","deliveryAddress":{"@type":"PostalAddress","streetAddress":"12 Elm St"},"trackingNumber":"1Z999AA10123456784","carrier":{"@type":"Organization","name":"UPS"},"partOfOrder":{"@type":"Order","orderNumber":"PRC-77120"}}
</script></head><body>
<p>Your order PRC-77120 has shipped with UPS.</p>
<p>Tracking number: <a href="https://parcelly.example/track/1Z999AA10123456784">1Z999AA10123456784</a></p>
</body></html>`,
  expect: {
    hidden: false,
    absent: ["@context", "ParcelDelivery"],
    present: ["Your order PRC-77120 has shipped with UPS."],
    links: [{ text: "1Z999AA10123456784", href: "https://parcelly.example/track/1Z999AA10123456784" }],
  },
});
