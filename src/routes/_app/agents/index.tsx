import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BotIcon, PlugZapIcon, PlusIcon } from "lucide-react";
import { AgentCard } from "@/components/agents/agent-card";
import { ConnectAgentDialog } from "@/components/agents/connect-agent-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { PageHeader, QueryError } from "@/components/common";
import { PairingCallout } from "@/components/overview/attention";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/agents/")({
  validateSearch: (s: Record<string, unknown>): { connect?: boolean } => ({ connect: s.connect === true || s.connect === "true" ? true : undefined }),
  component: AgentsPage,
});

function AgentsPage() {
  const agents = useQuery(queries.agents());
  const accounts = useQuery(queries.accounts());
  const pairings = useQuery(queries.pairings("pending"));
  const { connect } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setConnect = (open: boolean) => void navigate({ search: { connect: open || undefined }, replace: true });

  const connectButton = (
    <Button onClick={() => setConnect(true)}>
      <PlugZapIcon /> Connect an agent
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent has its own key and its own permissions per mailbox. Connect one from its own terminal, or create one here and paste its key."
        actions={
          <>
            <CreateAgentDialog
              trigger={
                <Button variant="outline">
                  <PlusIcon /> Create with key
                </Button>
              }
            />
            {connectButton}
          </>
        }
      />
      <PairingCallout pairings={pairings.data ?? []} />
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
                The easiest way: run one command on the machine where Claude Code, Codex, Cursor or Hermes runs, then approve it here. No keys to
                copy.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row flex-wrap justify-center">
              {connectButton}
              <CreateAgentDialog
                trigger={
                  <Button variant="outline">
                    <PlusIcon /> Create with key
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
      <ConnectAgentDialog open={!!connect} onOpenChange={setConnect} />
    </>
  );
}
