/**
 * Legit: a loyalty-programme welcome ("You are now a new member of …"). The "you are now an?
 * (…|new|different)" alternative matches any "you are now a new <noun>".
 * Expected: no suspiciousInstructions. Fix: require a persona noun after new/different
 * (you are now an? (?:new|different) (?:ai|assistant|agent|model|persona)).
 */
import { fixture } from "../fixture.ts";

export default fixture({
  subject: "Welcome to Bean Rewards",
  from: { name: "Bean & Leaf", email: "rewards@beanleaf.example" },
  html: `<h1>Welcome!</h1><p>Congratulations, Chris. You are now a new member of Bean Rewards, and your first drink is on us.</p><p>Your member number is BR-559201.</p>`,
  expect: {
    hidden: false,
    present: ["You are now a new member of Bean Rewards, and your first drink is on us.", "Your member number is BR-559201."],
  },
});
