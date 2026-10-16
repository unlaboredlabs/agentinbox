import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SKILL_URL_PLACEHOLDER = "{{XAQ_URL}}";
export const SKILL_NAME = "xaq";
/** The skill's name before the rename: `skill install` replaces it rather than leaving two. */
export const LEGACY_SKILL_NAME = "agentinbox";

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

/** The skills directory `--target` names (a known agent name or a path). */
const skillsDir = (target: string) => {
  const known = SKILL_TARGETS[target as keyof typeof SKILL_TARGETS];
  return known ? known() : resolve(target);
};

/** Resolves `--target` (a known agent name or a skills directory) to the SKILL.md path to write. */
export function skillPath(target: string): string {
  return join(skillsDir(target), SKILL_NAME, "SKILL.md");
}

/**
 * Removes the pre-rename `agentinbox/SKILL.md` next to the new skill, so the agent doesn't see two. Only a
 * SKILL.md that is ours (`name: agentinbox`) goes, and the directory only if nothing else is in it.
 * Returns the removed file, or null.
 */
export function removeLegacySkill(target: string): string | null {
  const dir = join(skillsDir(target), LEGACY_SKILL_NAME);
  const file = join(dir, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!/^---\s*\n(?:.*\n)*?name:\s*agentinbox\s*\n/.test(text)) return null;
  rmSync(file);
  try {
    if (!readdirSync(dir).length) rmdirSync(dir);
  } catch {
    // Not ours to clean up.
  }
  return file;
}

export function writeSkill(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
