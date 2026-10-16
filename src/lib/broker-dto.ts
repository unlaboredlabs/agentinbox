// The broker console's own view types: the tiny adapter over the /api/connections DTOs in shared/types.ts.
// The API has grants per connection (GET/PUT /api/connections/:id/grants); the agent page wants one agent's level
// on every connection, so it builds AgentConnection rows from the connections and their grants
// (connection-flow.ts agentConnections / grantsWith). Relative imports only: vitest loads this module too.

import type { AccessLevel, ConnectionStatus } from "../../shared/types.ts";

/** An agent's level on one connection; "none" = no grant row. */
export type AgentLevel = AccessLevel | "none";

export interface AgentConnection {
  connectionId: string;
  slug: string;
  name: string;
  status: ConnectionStatus;
  level: AgentLevel;
}
