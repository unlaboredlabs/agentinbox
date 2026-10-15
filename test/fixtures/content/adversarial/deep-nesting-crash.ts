/**
 * Adversarial: ~2,500 nested <div>s (about 14 KB of HTML) around a visible line. turndown's DOM
 * (domino) computes textContent recursively and overflows the stack from ~2,000 levels (cleanTree
 * itself from ~10,000), so buildContent throws RangeError. An attacker can make a message, and every
 * get_thread call on its thread, unreadable for the agent.
 * Expected: no throw; the visible text is returned (deep nesting flattened or the parse depth capped).
 */
import { fixture } from "../fixture.ts";

const depth = 2500;

export default fixture({
  subject: "Hello",
  html: `<p>Before the nest.</p>${"<div>".repeat(depth)}Deep visible line.${"</div>".repeat(depth)}<p>After the nest.</p>`,
  expect: {
    hidden: false,
    present: ["Before the nest.", "Deep visible line.", "After the nest."],
    maxMs: 5000,
  },
  bug: "deeply nested HTML (>= ~2000 levels) makes buildContent throw RangeError (stack overflow in turndown/domino and cleanTree)",
});
