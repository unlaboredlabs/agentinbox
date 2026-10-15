import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { HistoryIcon, StampIcon } from "lucide-react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { ApprovalHistory } from "@/components/approvals/approval-history";
import { PageHeader, QueryError } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/approvals")({
  validateSearch: (s: Record<string, unknown>): { tab?: "history" } => ({ tab: s.tab === "history" ? "history" : undefined }),
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const pending = useQuery(queries.approvals("pending"));
  const all = useQuery({ ...queries.approvals(), enabled: tab === "history" });
  const history = (all.data ?? []).filter((a) => a.status !== "pending");
  const count = pending.data?.length ?? 0;

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Messages from agents whose grant is set to “Needs approval”. Approving sends the draft; rejecting deletes it. Unanswered requests expire."
      />
      <Tabs value={tab ?? "pending"} onValueChange={(v) => void navigate({ search: { tab: v === "history" ? "history" : undefined }, replace: true })}>
        <TabsList>
          <TabsTrigger value="pending">
            Pending
            {count > 0 && (
              <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 tabular">
                {count}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="pending" className="mt-4 space-y-4">
          {pending.isPending ? (
            <Skeleton className="h-80 rounded-xl" />
          ) : pending.isError ? (
            <QueryError error={pending.error} onRetry={() => void pending.refetch()} />
          ) : count === 0 ? (
            <Card>
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <StampIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing waiting for you</EmptyTitle>
                  <EmptyDescription>
                    When an agent with send mode “Needs approval” sends a message, it shows up here. The sidebar shows a count when something's pending.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Card>
          ) : (
            pending.data.map((a) => <ApprovalCard key={a.id} approval={a} />)
          )}
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          {all.isPending ? (
            <Skeleton className="h-60 rounded-xl" />
          ) : all.isError ? (
            <QueryError error={all.error} onRetry={() => void all.refetch()} />
          ) : history.length === 0 ? (
            <Card>
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HistoryIcon />
                  </EmptyMedia>
                  <EmptyTitle>No decisions yet</EmptyTitle>
                  <EmptyDescription>Approved, rejected and expired requests are listed here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Card>
          ) : (
            <ApprovalHistory items={history} />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
