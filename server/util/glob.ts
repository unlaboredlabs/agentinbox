/**
 * Case-insensitive address globs used by grant allowlists (`allowTo`) and webhook filters
 * (`from`, `to`). `*` matches any run of characters, everything else is literal:
 * "*@example.com", "billing@*", "alice@example.com".
 *
 * Case folding is ASCII-only: Unicode folding would let look-alikes such as the Kelvin sign (U+212A)
 * match "k". Domains are NFKC-normalized first (as IDNA does), local parts are compared as written.
 */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function normalize(address: string): string {
  const s = address.trim();
  const at = s.lastIndexOf("@");
  if (at < 0) return asciiLower(s);
  return asciiLower(s.slice(0, at)) + "@" + asciiLower(s.slice(at + 1).normalize("NFKC"));
}

export function globToRegExp(glob: string): RegExp {
  const body = normalize(glob)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "s");
}

export function matchesGlob(value: string, glob: string): boolean {
  return globToRegExp(glob).test(normalize(value));
}

export function matchesAnyGlob(value: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(value, g));
}
