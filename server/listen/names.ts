import { existsSync, readFileSync } from "node:fs";
import { LEGACY_PRODUCT, PRODUCT } from "../brand.ts";
import { DEFAULT_PROFILE, profilePath, validProfileName } from "./paths.ts";

/**
 * The names a profile is known by in the agent's tools: its MCP server (`xaq`, or `xaq-<profile>`), which
 * is also its Hermes webhook route and, as `mcp-<server>`, the route's toolset.
 *
 * A profile made before the rename keeps `agentinbox` / `agentinbox-<profile>`: Hermes routes are confined
 * to `toolsets: ["mcp-agentinbox"]` and cron jobs to `["agentinbox"]`, saved Claude Code recipes allow
 * `mcp__agentinbox`, and the client configs register that name. Renaming any of them would quietly break
 * the others. So the name is saved in the profile (`mcpServer`): new profiles get `xaq…`, and a profile
 * without the field was made by agentinbox and keeps `agentinbox…` (written into the file the next time
 * it is saved).
 */

const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const isServerName = (s: unknown): s is string => typeof s === "string" && SERVER_NAME_RE.test(s);

const named = (base: string, profile: string) => (profile === DEFAULT_PROFILE ? base : `${base}-${profile}`);
/** The MCP server name a new profile gets. */
export const newServerName = (profile: string) => named(PRODUCT, validProfileName(profile));
/** The name a profile from before the rename was registered under. */
export const legacyServerName = (profile: string) => named(LEGACY_PRODUCT, validProfileName(profile));

/**
 * The server name saved in the profile file; for a profile file without one (made before the rename),
 * the pre-rename name; null when there is no profile file yet.
 */
export function savedServerName(profile: string): string | null {
  const path = profilePath(validProfileName(profile));
  if (!existsSync(path)) return null;
  try {
    const saved = (JSON.parse(readFileSync(path, "utf8")) as { mcpServer?: unknown } | null)?.mcpServer;
    if (isServerName(saved)) return saved;
  } catch {
    // Unreadable: loadProfile reports that properly; the name falls back like an old profile's.
  }
  return legacyServerName(profile);
}

/** The MCP server (and Hermes route) name for a profile: see the comment at the top. */
export const mcpServerName = (profile: string): string => savedServerName(profile) ?? newServerName(profile);

/**
 * The product name a profile's own texts use: "agentinbox" for a profile that kept its pre-rename names,
 * else "xaq". It names the server in the keyless Claude Code MCP config (`mcp__<it>` in the recipe) and
 * appears in the recipe prompts, so the commands saved in an old profile still match its recipes exactly.
 */
export const profileBrand = (profile: string): string => (mcpServerName(profile) === legacyServerName(profile) ? LEGACY_PRODUCT : PRODUCT);
