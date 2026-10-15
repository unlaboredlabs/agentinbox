/**
 * Case-insensitive address globs used by grant allowlists (`allowTo`) and webhook filters
 * (`from`, `to`). `*` matches any run of characters, everything else is literal:
 * "*@example.com", "billing@*", "alice@example.com".
 */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .trim()
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function matchesGlob(value: string, glob: string): boolean {
  return globToRegExp(glob).test(value.trim().toLowerCase());
}

export function matchesAnyGlob(value: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(value, g));
}
