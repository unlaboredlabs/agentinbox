import { existsSync } from "node:fs";

/**
 * The product name, and the one it had before (agentinbox → xaq). Installs from before the rename keep
 * working: their environment variables, data directory, services and agent-side names are still found.
 */
export const PRODUCT = "xaq";
export const LEGACY_PRODUCT = "agentinbox";

/**
 * `XAQ_<name>`, else the pre-rename `AGENTINBOX_<name>`. A set `XAQ_` variable wins even when empty
 * (an empty value is how some settings are switched off).
 */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[`XAQ_${name}`];
  return value !== undefined ? value : env[`AGENTINBOX_${name}`];
}

/** Whether this process runs under `service install` (XAQ_SERVICE=1; AGENTINBOX_SERVICE=1 in units from before the rename). */
export const underService = (env: NodeJS.ProcessEnv = process.env) => envVar("SERVICE", env) === "1";

/**
 * The directory to use out of a new and a pre-rename location: the new one when it exists, else the old
 * one when that exists, else the new one. Nothing is ever moved.
 */
export function pickDir(next: string, legacy: string): { dir: string; legacy: boolean } {
  if (!existsSync(next) && existsSync(legacy)) return { dir: legacy, legacy: true };
  return { dir: next, legacy: false };
}
