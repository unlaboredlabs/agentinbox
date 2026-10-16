import type { PairingRequest } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon, HistoryIcon, InfoIcon, KeyRoundIcon, StampIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { ApprovalHistory } from "@/components/approvals/approval-history";
import { asMcpApproval } from "@/components/approvals/mcp-call";
import { McpCallCard } from "@/components/approvals/mcp-call-card";
import { FindByCode, PairingApproveDialog, PairingCard, RecentPairings } from "@/components/approvals/pairing";
import { deniedDescription, linkedPairing } from "@/components/approvals/pairing-link";
import { Visible } from "@/components/hidden-chars";
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
  const link = search.pairing && pairings.data ? linkedPairing(search.pairing, pairings.data) : undefined;
  const linked = link?.kind === "pending" ? link.p : undefined;
  // Only the Find form on this page can mark a request as looked up by code: it lives in page state,
  // never in the URL, so a crafted link can't borrow the reassuring "matches the code" label.
  const [foundCode, setFoundCode] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Decisions only you can make: messages agents want to send, calendar changes they want to make, and agents asking for access."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => void navigate({ search: { tab: v === "messages" ? undefined : (v as "access" | "history") }, replace: true })}
      >
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            <TabsTrigger value="messages">
              Requests <Count n={count} />
            </TabsTrigger>
            <TabsTrigger value="access">
              Agent access <Count n={pendingPairings.length} />
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="messages" className="mt-4 space-y-4">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Sends, calendar changes and risky tool calls from agents set to ask you first. Approving sends the draft, applies the change or runs the call; rejecting deletes the draft
            or discards the change. Unanswered requests expire.
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
                  <EmptyTitle>Nothing waiting</EmptyTitle>
                  <EmptyDescription>
                    When an agent whose send mode is “Needs approval” sends a message, or one set to ask first changes a calendar, it waits here. The
                    sidebar shows a count when something's pending.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Card>
          ) : (
            pending.data.map((a) => {
              const mcp = asMcpApproval(a);
              return mcp ? <McpCallCard key={a.id} approval={mcp} /> : <ApprovalCard key={a.id} approval={a} />;
            })
          )}
        </TabsContent>

        <TabsContent value="access" className="mt-4 space-y-4">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Agents that ran <code className="font-mono text-foreground">npx xaq-cli connect</code> and are waiting for you. Names, hosts and
            reasons come from the agent itself. Approve only requests you started, after checking the code in your terminal.
          </p>
          {link?.kind === "denied" ? (
            <Alert>
              <XCircleIcon />
              <AlertTitle>
                You denied <Visible text={link.p.name} />
              </AlertTitle>
              <AlertDescription>
                {deniedDescription(link.p.decisionNote)} Changed your mind? Run connect again for a new request.
              </AlertDescription>
            </Alert>
          ) : link?.kind === "approved" ? (
            <Alert variant="success">
              <CheckCircle2Icon />
              <AlertTitle>
                You approved <Visible text={link.p.name} />
              </AlertTitle>
              <AlertDescription>
                <p>
                  Its key is ready for the agent's terminal.{" "}
                  {link.p.agentId && (
                    <Link to="/agents/$agentId" params={{ agentId: link.p.agentId }} className="font-medium text-foreground underline underline-offset-4">
                      Open agent
                    </Link>
                  )}
                </p>
              </AlertDescription>
            </Alert>
          ) : link?.kind === "gone" ? (
            <Alert>
              <InfoIcon />
              <AlertTitle>That request isn't waiting anymore</AlertTitle>
              <AlertDescription>
                It expired (codes last 10 minutes) or doesn't exist. If your terminal is still waiting, check the code it shows; otherwise run
                connect again.
              </AlertDescription>
            </Alert>
          ) : null}
          {pairings.isPending ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : pairings.isError ? (
            <QueryError error={pairings.error} onRetry={() => void pairings.refetch()} />
          ) : (
            <>
              {pendingPairings.length > 0 && <FindByCode pending={pendingPairings} onFound={(p) => {
                    setFoundCode(p.userCode);
                    void navigate({ search: { pairing: p.userCode }, replace: true });
                  }} />}
              {pendingPairings.length === 0 ? (
                <Card>
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <KeyRoundIcon />
                      </EmptyMedia>
                      <EmptyTitle>No agents waiting for access</EmptyTitle>
                      <EmptyDescription>
                        Run <code className="font-mono">npx xaq-cli connect</code> on the agent's machine. Its request shows up here
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
                    highlighted={p.id === linked?.id ? (foundCode === p.userCode ? "found" : "link") : undefined}
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
                  <EmptyDescription>Approved, rejected and expired messages and calendar changes are listed here.</EmptyDescription>
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
