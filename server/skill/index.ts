import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SKILL_URL_PLACEHOLDER = "{{AGENTINBOX_URL}}";
export const SKILL_NAME = "agentinbox";

/** Agent skill directories `skill install --target` knows by name. */
export const SKILL_TARGETS = {
  claude: () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills"),
  codex: () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
  agents: () => join(homedir(), ".agents", "skills"),
} as const;

let template: string | undefined;

/**
 * The SKILL.md template. Source runs read server/skill/SKILL.md next to this module; the bundle
 * (dist/cli.js) reads the copy tsdown places in dist/skill/.
 */
export function skillTemplate(): string {
  if (template !== undefined) return template;
  const candidates = [join(import.meta.dirname, "SKILL.md"), join(import.meta.dirname, "skill", "SKILL.md")];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`SKILL.md not found (looked in ${candidates.join(", ")})`);
  template = readFileSync(file, "utf8");
  return template;
}

/** SKILL.md with the instance URL filled in (no trailing slash). */
export function renderSkill(url: string): string {
  return skillTemplate().replaceAll(SKILL_URL_PLACEHOLDER, url.replace(/\/+$/, ""));
}

/** Resolves `--target` (a known agent name or a skills directory) to the SKILL.md path to write. */
export function skillPath(target: string): string {
  const known = SKILL_TARGETS[target as keyof typeof SKILL_TARGETS];
  return join(known ? known() : resolve(target), SKILL_NAME, "SKILL.md");
}

export function writeSkill(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
