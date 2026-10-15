import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { ActionName, DenialReason, OutcomeBadge } from "@/components/audit/audit-bits";
import { QueryError, TimeAgo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";
import { isToolCall } from "@/components/agents/agent-status";

/** The agent's latest MCP tool calls (the same rule as Overview's count; pairing and console actions are in the full log). */
export function AgentActivity({ agentId }: { agentId: string }) {
  const q = useQuery(queries.recentAudit(agentId));
  const items = q.data?.items.filter((e) => isToolCall(e, agentId)).slice(0, 10) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent tool calls</CardTitle>
        <CardDescription>Tool calls this agent made, including anything a guardrail blocked.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/audit" search={{ agentId }}>
              Full log <ArrowRightIcon />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {q.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No tool calls yet. They appear here as soon as the agent uses its key.</p>
        ) : (
          <ul className="divide-y">
            {items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <ActionName action={e.action} />
                <OutcomeBadge outcome={e.outcome} />
                {e.outcome === "denied" && <DenialReason reason={e.reason} />}
                <span className="ml-auto text-xs text-muted-foreground">
                  <TimeAgo date={e.ts} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
