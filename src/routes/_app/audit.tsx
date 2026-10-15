import type { AuditOutcome } from "@shared/types";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { AuditTable } from "@/components/audit/audit-table";
import { PageHeader, QueryError } from "@/components/common";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { queries } from "@/lib/queries";
import { useStreamListener } from "@/lib/stream";

const OUTCOMES = ["ok", "denied", "error"] as const;

export const Route = createFileRoute("/_app/audit")({
  validateSearch: (s: Record<string, unknown>): { agentId?: string; outcome?: AuditOutcome } => ({
    agentId: typeof s.agentId === "string" ? s.agentId : undefined,
    outcome: OUTCOMES.find((o) => o === s.outcome),
  }),
  component: AuditPage,
});

function AuditPage() {
  const { agentId, outcome } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const [action, setAction] = useState("");
  const [fresh, setFresh] = useState(0);
  const agents = useQuery(queries.agents());
  const accounts = useQuery(queries.accounts());
  const opts = queries.audit({ agentId, outcome });
  const log = useInfiniteQuery(opts);

  // New entries are announced rather than injected, so the rows you're reading don't shift.
  useStreamListener((m) => {
    if (m.kind !== "audit") return;
    if (agentId && m.data.actorId !== agentId) return;
    if (outcome && m.data.outcome !== outcome) return;
    setFresh((n) => n + 1);
  });

  const showFresh = () => {
    setFresh(0);
    void qc.resetQueries({ queryKey: opts.queryKey });
  };

  const setFilter = (patch: { agentId?: string; outcome?: AuditOutcome }) => {
    setFresh(0);
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });
  };

  const needle = action.trim().toLowerCase();
  const entries = (log.data?.pages.flatMap((p) => p.items) ?? []).filter((e) => !needle || e.action.toLowerCase().includes(needle));
  const filtered = !!(agentId || outcome || needle);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every tool call agents make and every change made in this console. Denied rows show which guardrail blocked the action."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={agentId ?? "all"} onValueChange={(v) => setFilter({ agentId: v === "all" ? undefined : v })}>
          <SelectTrigger className="w-full sm:w-52" aria-label="Agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actors</SelectItem>
            {agents.data?.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={outcome ?? "all"} onValueChange={(v) => setFilter({ outcome: v === "all" ? undefined : (v as AuditOutcome) })}>
          <SelectTrigger className="w-full sm:w-40" aria-label="Outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any outcome</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
            <SelectItem value="denied">Denied</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <InputGroup className="w-full sm:w-60">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput placeholder="Filter by action…" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action" />
        </InputGroup>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAction("");
              setFilter({ agentId: undefined, outcome: undefined });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {fresh > 0 && (
        <div className="flex justify-center">
          <Button size="sm" variant="secondary" onClick={showFresh} className="rounded-full shadow-sm">
            <ArrowUpIcon /> {fresh} new entr{fresh === 1 ? "y" : "ies"}
          </Button>
        </div>
      )}

      {log.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : log.isError ? (
        <QueryError error={log.error} onRetry={() => void log.refetch()} />
      ) : (
        <>
          <AuditTable
            entries={entries}
            accounts={accounts.data ?? []}
            empty={
              filtered
                ? needle && log.hasNextPage
                  ? "No matching entries in the loaded pages. Load more to search further back."
                  : "No entries match these filters."
                : "Nothing recorded yet. Agent tool calls and console changes will show up here."
            }
          />
          {log.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
                {log.isFetchingNextPage && <Spinner />} Load older entries
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
