import type { AgentTool } from "@shared/agent-api";
import type { Agent, AuditEntry } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { TOOL_LABEL } from "@/lib/cli";
import { queries } from "@/lib/queries";

/**
 * How the agent was added: paired from its terminal (`connect`, the key lives in a profile on that
 * machine) or created here with a copied key. Pairings are kept for a while after approval; an agent
 * with a listener was certainly paired (listen uses the profile's key).
 */
export function useAgentOrigin(agent: Agent | undefined): { paired: boolean; tool: AgentTool | null; known: boolean } {
  const pairings = useQuery({ ...queries.pairings("approved"), enabled: !!agent });
  const p = agent ? pairings.data?.find((x) => x.agentId === agent.id) : undefined;
  const t = p?.client.tool;
  return {
    paired: !!p || !!agent?.listeners.length,
    tool: t && t in TOOL_LABEL ? (t as AgentTool) : null,
    known: !pairings.isPending,
  };
}

/** MCP tool names are snake_case; console and pairing actions are dotted (agent.create, pairing.key_delivered). */
const isToolCall = (e: AuditEntry, agentId: string) => e.actorType === "agent" && e.actorId === agentId && /^[a-z_]+$/.test(e.action);

/**
 * Evidence that the agent's tool talks to agentinbox over MCP.
 * - lastToolCall: an MCP tool call in the audit log (exact).
 * - connectedAt: `lastUsedAt`, but only while no listener exists: lastUsedAt is set by every use of
 *   the key (MCP, including the tools/list a tool runs at startup, and also `listen`), so once a
 *   listener has connected it proves nothing about MCP.
 */
export function useMcpActivity(agent: Agent | undefined, opts: { since?: string } = {}) {
  const audit = useQuery({ ...queries.recentAudit(agent?.id ?? ""), enabled: !!agent });
  const since = opts.since ? Date.parse(opts.since) : 0;
  const calls = agent ? (audit.data?.items ?? []).filter((e) => isToolCall(e, agent.id) && Date.parse(e.ts) >= since) : [];
  const lastToolCall = calls[0] ?? null;
  const connectedAt = agent?.lastUsedAt && agent.listeners.length === 0 && Date.parse(agent.lastUsedAt) >= since ? agent.lastUsedAt : null;
  return { lastToolCall, calls, connectedAt, seenAt: lastToolCall?.ts ?? connectedAt };
}
