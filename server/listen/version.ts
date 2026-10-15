import { readFileSync } from "node:fs";
import { join } from "node:path";

/** package.json sits above dist/ (bundled) or two levels above server/listen/ (source). */
function readVersion(): string {
  for (const rel of ["..", "../.."]) {
    try {
      const pkg = JSON.parse(readFileSync(join(import.meta.dirname, rel, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "agentinbox" && pkg.version) return pkg.version;
    } catch {
      // Try the next candidate.
    }
  }
  return "0.0.0";
}

export const version = readVersion();
