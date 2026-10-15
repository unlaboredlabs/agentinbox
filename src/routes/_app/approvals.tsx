import type { PairingRequest } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { HistoryIcon, InfoIcon, KeyRoundIcon, StampIcon } from "lucide-react";
import { useState } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { ApprovalHistory } from "@/components/approvals/approval-history";
import { FindByCode, PairingApproveDialog, PairingCard, RecentPairings } from "@/components/approvals/pairing";
import { PageHeader, QueryError } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { queries } from "@/lib/queries";

type Tab = "messages" | "access" | "history";
interface Search {
  tab?: "access" | "history";
  /** User code from the terminal's verification link: opens Agent access and highlights that request. */
  pairing?: string;
}

export const Route = createFileRoute("/_app/approvals")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: s.tab === "history" || s.tab === "access" ? s.tab : undefined,
    pairing: typeof s.pairing === "string" && s.pairing ? s.pairing.toUpperCase().slice(0, 12) : undefined,
  }),
  component: ApprovalsPage,
});

const Count = ({ n }: { n: number }) =>
  n > 0 ? (
    <Badge variant="secondary" className="ml-1 h-4 min-w-4 bg-warning/25 px-1 tabular">
      {n}
    </Badge>
  ) : null;

function ApprovalsPage() {
  const search = Route.useSearch();
  const tab: Tab = search.pairing ? "access" : (search.tab ?? "messages");
  const navigate = useNavigate({ from: Route.fullPath });
  const pending = useQuery(queries.approvals("pending"));
  const all = useQuery({ ...queries.approvals(), enabled: tab === "history" });
  const pairings = useQuery(queries.pairings());
  const accounts = useQuery(queries.accounts());
  const history = (all.data ?? []).filter((a) => a.status !== "pending");
  const count = pending.data?.length ?? 0;
  const pendingPairings = (pairings.data ?? []).filter((p) => p.status === "pending");
  const decidedPairings = (pairings.data ?? []).filter((p) => p.status !== "pending").slice(0, 8);
  const [approving, setApproving] = useState<{ p: PairingRequest } | null>(null);
  const linked = search.pairing ? pendingPairings.find((p) => p.userCode === search.pairing) : undefined;

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Decisions only you can make: messages agents want to send, and agents asking for access to your mail."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => void navigate({ search: { tab: v === "messages" ? undefined : (v as "access" | "history") }, replace: true })}
      >
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            <TabsTrigger value="messages">
              Messages <Count n={count} />
            </TabsTrigger>
            <TabsTrigger value="access">
              Agent access <Count n={pendingPairings.length} />
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="messages" className="mt-4 space-y-4">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Sends from agents whose grant is set to “Needs approval”. Approving sends the draft; rejecting deletes it. Unanswered requests expire.
          </p>
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
                  <EmptyTitle>No messages waiting</EmptyTitle>
                  <EmptyDescription>
                    When an agent whose send mode is “Needs approval” sends a message, it waits here. The sidebar shows a count when something's
                    pending.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Card>
          ) : (
            pending.data.map((a) => <ApprovalCard key={a.id} approval={a} />)
          )}
        </TabsContent>

        <TabsContent value="access" className="mt-4 space-y-4">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Agents that ran <code className="font-mono text-foreground">npx agentinbox-cli connect</code> and are waiting for you. Names, hosts and
            reasons come from the agent itself. Approve only requests you started, after checking the code in your terminal.
          </p>
          {search.pairing && !pairings.isPending && !linked && (
            <Alert>
              <InfoIcon />
              <AlertTitle>That request isn't waiting anymore</AlertTitle>
              <AlertDescription>
                It was approved, denied or expired (codes last 10 minutes). If your terminal is still waiting, check the code it shows; otherwise
                run connect again.
              </AlertDescription>
            </Alert>
          )}
          {pairings.isPending ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : pairings.isError ? (
            <QueryError error={pairings.error} onRetry={() => void pairings.refetch()} />
          ) : (
            <>
              {pendingPairings.length > 0 && <FindByCode pending={pendingPairings} onFound={(p) => void navigate({ search: { pairing: p.userCode }, replace: true })} />}
              {pendingPairings.length === 0 ? (
                <Card>
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <KeyRoundIcon />
                      </EmptyMedia>
                      <EmptyTitle>No agents waiting for access</EmptyTitle>
                      <EmptyDescription>
                        Run <code className="font-mono">npx agentinbox-cli connect</code> on the agent's machine. Its request shows up here
                        instantly.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button variant="outline" asChild>
                        <Link to="/agents" search={{ connect: true }}>
                          How to connect an agent
                        </Link>
                      </Button>
                    </EmptyContent>
                  </Empty>
                </Card>
              ) : (
                pendingPairings.map((p) => (
                  <PairingCard
                    key={p.id}
                    p={p}
                    accounts={accounts.data ?? []}
                    highlighted={p.id === linked?.id}
                    onApprove={() => setApproving({ p })}
                  />
                ))
              )}
              <RecentPairings items={decidedPairings} />
            </>
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
                  <EmptyDescription>Approved, rejected and expired messages are listed here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Card>
          ) : (
            <ApprovalHistory items={history} />
          )}
        </TabsContent>
      </Tabs>

      <PairingApproveDialog
        p={approving?.p ?? null}
        accounts={accounts.data ?? []}
        onOpenChange={(o) => !o && setApproving(null)}
      />
    </>
  );
}
