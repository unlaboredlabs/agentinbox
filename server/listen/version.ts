import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The npm package (the command it installs is still `agentinbox`). Local until shared/types.ts
 * exports NPM_PACKAGE (being added on the platform branch); then import it from there.
 */
export const NPM_PACKAGE = "agentinbox-cli";
/** How printed instructions invoke the CLI without a global install. */
export const NPX = `npx ${NPM_PACKAGE}`;

/** package.json sits above dist/ (bundled) or two levels above server/listen/ (source). */
function readVersion(): string {
  for (const rel of ["..", "../.."]) {
    try {
      const pkg = JSON.parse(readFileSync(join(import.meta.dirname, rel, "package.json"), "utf8")) as { name?: string; version?: string };
      if ((pkg.name === "agentinbox" || pkg.name === NPM_PACKAGE) && pkg.version) return pkg.version;
    } catch {
      // Try the next candidate.
    }
  }
  return "0.0.0";
}

export const version = readVersion();
