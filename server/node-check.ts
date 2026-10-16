/** The oldest Node.js xaq runs on (node:sqlite unflagged, import.meta.dirname). Keep in sync with package.json engines. */
export const MIN_NODE = "22.13.0";

/** An explanation when `version` (e.g. process.versions.node) is too old, else null. */
export function nodeVersionError(version: string): string | null {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const have = parse(version);
  const need = parse(MIN_NODE);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > need[i]!) return null;
    if ((have[i] ?? 0) < need[i]!) return `xaq needs Node.js 22.13 or newer (you have ${version.replace(/^v?/, "v")}). Install a current Node.js from https://nodejs.org and try again.`;
  }
  return null;
}

// Runs on import, before anything that needs a newer Node is loaded.
const problem = nodeVersionError(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(1);
}
