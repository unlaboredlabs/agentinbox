/**
 * Legit: an AI-engineering newsletter (exactly what this product's users subscribe to) that mentions
 * "system prompt" as a topic. The bare \bsystem\s+prompt\b pattern flags it.
 * Expected: no suspiciousInstructions. Fix: require an action on it (reveal|print|show|ignore|
 * override … (your|the) system prompt), not the noun phrase alone.
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Prompt Engineering Weekly: writing better system prompts",
  from: { name: "Prompt Engineering Weekly", email: "editor@promptweekly.example" },
  html: `<h2>This week</h2><p>We compare three ways to structure a system prompt for tool-using agents, and benchmark how much caching saves on long contexts.</p><p><a href="https://promptweekly.example/issues/88">Read issue #88</a></p>`,
  expect: {
    hidden: false,
    present: ["We compare three ways to structure a system prompt for tool-using agents"],
    links: [{ text: "Read issue #88", href: "https://promptweekly.example/issues/88" }],
  },
  decision: "Flag requests to reveal/ignore a system prompt, not mentions of the term.",
});
