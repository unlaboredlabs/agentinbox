import type { AgentTool } from "@shared/agent-api";
import { type Agent, type AuditEntry, isMcpToolAction } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { TOOL_LABEL } from "@/lib/cli";
import { queries } from "@/lib/queries";

/**
 * How the agent was added (Agent.origin): paired from its terminal (`connect`, the key lives in a
 * profile on that machine) or created here with a copied key. The tool it named comes from its
 * pairing request, which is pruned after the retention period (then `tool` is null).
 * `known` is false only while a paired agent's tool is still loading.
 */
export function useAgentOrigin(agent: Agent | undefined): { paired: boolean; tool: AgentTool | null; known: boolean } {
  const paired = agent?.origin === "paired";
  const pairings = useQuery({ ...queries.pairings("approved"), enabled: paired });
  const p = agent && paired ? pairings.data?.find((x) => x.agentId === agent.id) : undefined;
  const t = p?.client.tool;
  return {
    paired,
    tool: t && t in TOOL_LABEL ? (t as AgentTool) : null,
    known: !!agent && (!paired || !pairings.isPending),
  };
}

/** An MCP tool call by this agent (the server counts them with the same rule, see isMcpToolAction). */
export const isToolCall = (e: AuditEntry, agentId: string) => e.actorType === "agent" && e.actorId === agentId && isMcpToolAction(e.action);

/**
 * Evidence that the agent's tool talks to agentinbox over MCP.
 * - lastToolCall: an MCP tool call in the audit log (exact).
 * - connectedAt: `lastMcpAt`, set by any request to /mcp (including the tools/list a tool runs at
 *   startup, which isn't audited), never by `listen`.
 */
export function useMcpActivity(agent: Agent | undefined, opts: { since?: string } = {}) {
  const audit = useQuery({ ...queries.recentAudit(agent?.id ?? ""), enabled: !!agent });
  const since = opts.since ? Date.parse(opts.since) : 0;
  const calls = agent ? (audit.data?.items ?? []).filter((e) => isToolCall(e, agent.id) && Date.parse(e.ts) >= since) : [];
  const lastToolCall = calls[0] ?? null;
  const connectedAt = agent?.lastMcpAt && Date.parse(agent.lastMcpAt) >= since ? agent.lastMcpAt : null;
  return { lastToolCall, calls, connectedAt, seenAt: lastToolCall?.ts ?? connectedAt };
}
