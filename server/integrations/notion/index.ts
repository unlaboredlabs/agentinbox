import type { IntegrationPreset, SetupContext, SetupStep, ToolClass, ToolDef } from "../../broker/types.ts";
import { NOTION_ALIASES, NOTION_TOOLS, type NotionToolSpec } from "./tools.ts";

export const NOTION_MCP_URL = "https://mcp.notion.com/mcp";

function specFor(name: string): NotionToolSpec | undefined {
  if (Object.hasOwn(NOTION_TOOLS, name)) return NOTION_TOOLS[name];
  const alias = Object.hasOwn(NOTION_ALIASES, name) ? NOTION_ALIASES[name] : undefined;
  return alias ? NOTION_TOOLS[alias] : undefined;
}

/** The first candidate argument the tool's input schema declares (Notion doesn't document these names). */
function targetPath(tool: ToolDef, candidates: string[] | undefined): string | undefined {
  const props = tool.inputSchema.properties;
  if (!candidates || !props || typeof props !== "object") return undefined;
  return candidates.find((c) => Object.hasOwn(props, c));
}

/** Preset classification; null for tools Notion hadn't documented (generic heuristic applies). */
export function classifyNotionTool(tool: ToolDef): ToolClass | null {
  const spec = specFor(tool.name);
  if (!spec) return null;
  const cls: ToolClass = { risky: spec.cls === "risky", read: spec.cls === "read", source: "preset" };
  const path = targetPath(tool, spec.target);
  if (path) cls.targetPath = path;
  return cls;
}

export function notionSetupSteps(_ctx: SetupContext): SetupStep[] {
  return [
    {
      id: "connect",
      title: "Connect",
      body: "Press Connect and we'll open Notion's sign-in. There's no app to create and nothing to copy.",
    },
    {
      id: "approve",
      title: "In Notion, choose the workspace and approve",
      body:
        "Pick the workspace your agents should use and approve. Agents can then reach what you can see in that " +
        "workspace, limited by the access level you choose next. On Business and Enterprise plans a workspace owner " +
        "controls which MCP clients may connect (in Notion: Settings, Notion MCP, Manage workspace clients). If Notion " +
        "refuses the connection, ask an owner to allow it.",
    },
    {
      id: "reconnect",
      title: "Reconnect every 180 days",
      body:
        "Notion asks you to reconnect at least every 180 days, and after 30 days without use. We'll remind you " +
        "before that happens; reconnecting is the same two steps.",
    },
  ];
}

export const notionPreset: IntegrationPreset = {
  id: "notion",
  displayName: "Notion",
  slug: "notion",
  kind: "remote_http",
  url: NOTION_MCP_URL,
  auth: { type: "mcp_oauth" },
  classify: classifyNotionTool,
  setupSteps: notionSetupSteps,
  reconnectPolicy: { maxLifetimeDays: 180, idleDays: 30 },
};
