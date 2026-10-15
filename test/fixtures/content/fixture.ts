// Shared types and helpers for the content-cleaning corpus (test/content-corpus.test.ts).
//
// Each corpus file under adversarial/ or legit/ default-exports one ContentFixture: a realistic email
// (HTML and/or text/plain) plus what the cleaner must do with it. The directory is the kind:
//   adversarial/  hidden payloads must be removed, visible content kept, hiddenContentRemoved = true
//   legit/        real-world mail must survive with high fidelity and no false-positive signals
//
// Generic checks run for every fixture (see the test file): no HTML tags leak, no invisible/smuggling
// characters reach the rendered output, exactly one <email_content> opener and closer (and no
// delimiter look-alikes), and for legit mail no suspiciousInstructions unless the fixture says so.

import type { Address, Attachment } from "../../../shared/types.ts";

export interface ExpectedLink {
  text: string;
  /** Exact href as the agent should see it (before markdown escaping of parentheses). */
  href: string;
}

export interface ContentExpectation {
  /** signals.hiddenContentRemoved. Omit to leave unasserted (only where the fixture documents why). */
  hidden?: boolean;
  /** Hidden payload snippets: must not appear (case-insensitive) anywhere in the rendered message. */
  absent?: string[];
  /** Visible text: must appear verbatim in the cleaned body (markdown, so mind `\_` escaping). */
  present?: string[];
  /** Links that must survive as markdown links with the same href. */
  links?: ExpectedLink[];
  /** GFM table lines that must appear verbatim. */
  tables?: string[];
  /**
   * signals.suspiciousInstructions: "none" (empty), "any" (at least one hit), or snippets that must
   * each be contained (case-insensitive) in some hit. Default: "none" for legit mail, unasserted otherwise.
   */
  suspicious?: "none" | "any" | string[];
  /** The visible text legitimately contains tag-like text (code samples): skip the tag-leak check. */
  allowTags?: boolean;
  /** Expected content.truncated (only meaningful with maxChars). */
  truncated?: boolean;
  /** Upper bound for buildContent + renderMessage, in milliseconds. */
  maxMs?: number;
}

export interface ContentFixture {
  html?: string | null;
  text?: string | null;
  subject?: string;
  from?: Address;
  attachments?: Attachment[];
  authenticationResults?: string | null;
  /** Operator maxBodyChars (0 = unlimited, the default). */
  maxChars?: number;
  expect: ContentExpectation;
  /**
   * The cleaner currently gets this case wrong. Names the bug; the corpus test runs the case with
   * `it.fails` so it flips to a failure (remove this field) once the cleaner is fixed.
   */
  bug?: string;
  /** A philosophy decision this fixture pins down, for the content owner to confirm. */
  decision?: string;
}

export const fixture = (f: ContentFixture): ContentFixture => f;

// ───────────── Unicode helpers (keeps invisible characters reviewable in source) ─────────────

export const ch = (...cps: number[]) => String.fromCodePoint(...cps);
export const ZWSP = ch(0x200b);
export const ZWNJ = ch(0x200c);
export const ZWJ = ch(0x200d);
export const WJ = ch(0x2060);
export const BOM = ch(0xfeff);
export const LRM = ch(0x200e);
export const RLM = ch(0x200f);
export const ALM = ch(0x061c);
export const LRE = ch(0x202a);
export const RLE = ch(0x202b);
export const PDF = ch(0x202c);
export const LRO = ch(0x202d);
export const RLO = ch(0x202e);
export const LRI = ch(0x2066);
export const RLI = ch(0x2067);
export const FSI = ch(0x2068);
export const PDI = ch(0x2069);
export const SHY = ch(0x00ad);

/** "ASCII smuggling": text re-encoded as Unicode tag characters (U+E0000 block), invisible when rendered. */
export const tags = (s: string) => ch(0xe0001) + [...s].map((c) => ch(0xe0000 + c.charCodeAt(0))).join("") + ch(0xe007f);

/** Same, but as HTML numeric character references (what an HTML body would carry). */
export const tagEntities = (s: string) => [...s].map((c) => `&#x${(0xe0000 + c.charCodeAt(0)).toString(16)};`).join("");

/**
 * "Emoji smuggling": one byte per variation selector (VS1–16 = U+FE00–FE0F for 0–15, VS17–256 =
 * U+E0100–E01EF for 16–255) appended to a visible base character. Renders as just the base glyph.
 */
export const variationSelectors = (s: string) =>
  [...new TextEncoder().encode(s)].map((b) => (b < 16 ? ch(0xfe00 + b) : ch(0xe0100 + b - 16))).join("");

/** Interleaves `sep` between every character of `s` (zero-width evasion of keyword filters). */
export const interleave = (s: string, sep: string) => [...s].join(sep);
