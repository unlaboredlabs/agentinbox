// When /mcp serves search mode instead of every tool (docs/MCP-BROKER.md, "One endpoint with 100+ tools").
import { type Db, json } from "../../db/index.ts";
import type { SettingsStore } from "../../settings.ts";

/** Above this many visible tools (native + broker), an agent gets search mode unless its setting says otherwise. */
export const SEARCH_MODE_THRESHOLD = 30;

/** Hot tools stay directly exposed in search mode: at most this many, get_call_status included. */
export const MAX_HOT_TOOLS = 5;

/** Configured hot tools when an agent's setting names none (beyond get_call_status). */
export const DEFAULT_HOT_TOOLS: readonly string[] = [];

/** The broker's approval-status tool; directly exposed in search mode whenever the agent has broker tools. */
export const CALL_STATUS_TOOL = "get_call_status";

export type ToolMode = "direct" | "search";

/** The per-agent choice: `auto` follows the threshold; `search` and `direct` force it (`?mode=search` still wins). */
export type AgentSearchPreference = "auto" | "search" | "direct";

export interface AgentSearchSettings {
  mode: AgentSearchPreference;
  /** Extra tools exposed directly in search mode (exposed names). */
  hot: string[];
}

const PREFERENCES: readonly AgentSearchPreference[] = ["auto", "search", "direct"];
const key = (agentId: string) => `broker.search:${agentId}`;

/** The agent's search-mode setting, kept in the settings table (no migration). */
export function agentSearchSettings(db: Db, agentId: string): AgentSearchSettings {
  const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key(agentId));
  const v = json.parse<Partial<AgentSearchSettings>>(row?.value, {});
  return {
    mode: PREFERENCES.includes(v.mode as AgentSearchPreference) ? (v.mode as AgentSearchPreference) : "auto",
    hot: Array.isArray(v.hot) ? v.hot.filter((x): x is string => typeof x === "string").slice(0, MAX_HOT_TOOLS) : [...DEFAULT_HOT_TOOLS],
  };
}

export function setAgentSearchSettings(db: Db, agentId: string, patch: Partial<AgentSearchSettings>): AgentSearchSettings {
  const next = { ...agentSearchSettings(db, agentId), ...patch };
  if (!PREFERENCES.includes(next.mode)) throw new Error(`Unknown search mode ${String(next.mode)}`);
  next.hot = [...new Set(next.hot)].slice(0, MAX_HOT_TOOLS);
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key(agentId),
    JSON.stringify(next),
  );
  return next;
}

/**
 * The `brokerUpstreams` feature flag (default off until the console PR). Read loosely: Settings doesn't declare
 * it on this branch, and SettingsStore.get() passes stored keys through.
 */
export function brokerUpstreamsEnabled(settings: SettingsStore): boolean {
  return (settings.get() as { brokerUpstreams?: unknown }).brokerUpstreams === true;
}

export interface ModeInput {
  /** `?mode=` on /mcp. */
  query: string | undefined;
  preference: AgentSearchPreference;
  /** Native tools this agent can use (registered TOOL_NAMES). */
  nativeCount: number;
  /** ToolRegistry.forAgent(agentId).length. */
  brokerCount: number;
}

export function chooseMode(m: ModeInput): ToolMode {
  if (m.query === "search") return "search";
  if (m.preference === "search") return "search";
  if (m.preference === "direct") return "direct";
  return m.nativeCount + m.brokerCount > SEARCH_MODE_THRESHOLD ? "search" : "direct";
}

/** Directly exposed tools in search mode: get_call_status when the agent has broker tools, then the configured ones. */
export function hotToolNames(brokerCount: number, configured: readonly string[]): string[] {
  const names = brokerCount > 0 ? [CALL_STATUS_TOOL, ...configured] : [...configured];
  return [...new Set(names)].slice(0, MAX_HOT_TOOLS);
}
