import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotIcon, PlusIcon } from "lucide-react";
import { AgentCard } from "@/components/agents/agent-card";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { PageHeader, QueryError } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/agents/")({
  component: AgentsPage,
});

function AgentsPage() {
  const agents = useQuery(queries.agents());
  const accounts = useQuery(queries.accounts());

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent has its own API key and per-mailbox permissions. Agents connect over MCP and can receive events by webhook."
        actions={<CreateAgentDialog />}
      />
      {agents.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : agents.isError ? (
        <QueryError error={agents.error} onRetry={() => void agents.refetch()} />
      ) : agents.data.length === 0 ? (
        <Card>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>No agents yet</EmptyTitle>
              <EmptyDescription>
                Create an agent to get an API key, then add agentinbox to Claude Code, Codex, Cursor or any MCP client.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <CreateAgentDialog
                trigger={
                  <Button>
                    <PlusIcon /> Create your first agent
                  </Button>
                }
              />
            </EmptyContent>
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.data.map((a) => (
            <AgentCard key={a.id} agent={a} accounts={accounts.data ?? []} />
          ))}
        </div>
      )}
    </>
  );
}
