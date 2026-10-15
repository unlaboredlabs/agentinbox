// Policy domain contract. Owned by the policy + MCP + mail work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type { Agent, AgentWithKey, CreateAgentInput, EventType, Grant, GrantInput } from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";

/** An authenticated agent (from its `aib_…` bearer key). */
export interface AgentPrincipal {
  agentId: string;
  name: string;
}

export interface PolicyService extends Lifecycle {
  /** FROZEN. Looks up a key by sha256; null if unknown or the agent is disabled. Updates last_used_at. */
  authenticate(apiKey: string): AgentPrincipal | null;

  listAgents(): Agent[];
  getAgent(id: string): Agent | null;
  createAgent(input: CreateAgentInput): AgentWithKey;
  updateAgent(id: string, patch: { name?: string; description?: string | null; disabled?: boolean }): Agent;
  rotateKey(id: string): AgentWithKey;
  deleteAgent(id: string): void;
  upsertGrant(agentId: string, accountId: string, input: GrantInput): Grant;
  deleteGrant(agentId: string, accountId: string): void;

  /** FROZEN. */
  grant(agentId: string, accountId: string): Grant | null;
  /** FROZEN. */
  grants(agentId: string): Grant[];
  /**
   * FROZEN. Event visibility for the agent feed and webhooks: the agent needs a grant with `read`
   * on the account, and for message/label events the thread labels must intersect its label scope.
   * Account-level events (account.auth_failed, sync.gap) only need the grant.
   */
  canSeeEvent(agentId: string, ev: { accountId: string; type: EventType; threadLabelIds: string[] }): boolean;
}
