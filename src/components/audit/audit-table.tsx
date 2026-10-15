import type { Account, AuditEntry } from "@shared/types";
import { useMemo } from "react";
import { CodeBlock, TimeAgo } from "@/components/common";
import { type Columns, DataTable, columnHelper } from "@/components/data-table";
import { fmtExact, fmtMs } from "@/lib/format";
import { ActionName, Actor, DenialReason, OutcomeBadge } from "./audit-bits";

const col = columnHelper<AuditEntry>();

export function AuditTable({ entries, accounts, empty }: { entries: AuditEntry[]; accounts: Account[]; empty?: React.ReactNode }) {
  const columns = useMemo<Columns<AuditEntry>>(() => {
    const email = (id: string | null) => (id ? (accounts.find((a) => a.id === id)?.email ?? id) : "—");
    return [
      col.accessor("ts", { header: "Time", cell: (c) => <TimeAgo date={c.getValue()} className="text-xs" />, meta: { className: "w-28" } }),
      col.display({
        id: "actor",
        header: "Actor",
        cell: (c) => (
          <div className="min-w-0 space-y-1">
            <Actor entry={c.row.original} />
            {/* Small screens: the action and outcome columns fold in here. */}
            <div className="flex flex-wrap items-center gap-1.5 sm:hidden">
              <ActionName action={c.row.original.action} />
              {c.row.original.outcome !== "ok" && <OutcomeBadge outcome={c.row.original.outcome} />}
            </div>
          </div>
        ),
        meta: { className: "max-w-56" },
      }),
      col.accessor("action", { header: "Action", cell: (c) => <ActionName action={c.getValue()} />, meta: { className: "hidden sm:table-cell" } }),
      col.accessor("accountId", {
        header: "Account",
        cell: (c) => <span className="block max-w-48 truncate text-muted-foreground">{email(c.getValue())}</span>,
        meta: { className: "hidden lg:table-cell" },
      }),
      col.accessor("outcome", {
        header: "Outcome",
        meta: { className: "hidden sm:table-cell" },
        cell: (c) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <OutcomeBadge outcome={c.getValue()} />
            {c.row.original.outcome !== "ok" && c.row.original.reason && (
              <span className="hidden md:inline">
                <DenialReason reason={c.row.original.reason} action={c.row.original.action} />
              </span>
            )}
          </div>
        ),
      }),
      col.accessor("durationMs", {
        header: "Duration",
        cell: (c) => <span className="text-muted-foreground tabular">{fmtMs(c.getValue())}</span>,
        meta: { className: "hidden text-right sm:table-cell" },
      }),
    ];
  }, [accounts]);

  return (
    <DataTable
      columns={columns}
      data={entries}
      getRowId={(e) => String(e.id)}
      empty={empty}
      rowClassName={(e) => (e.outcome === "denied" ? "bg-warning/5" : e.outcome === "error" ? "bg-critical/5" : undefined)}
      renderExpanded={(e) => <AuditDetail entry={e} email={accounts.find((a) => a.id === e.accountId)?.email} />}
    />
  );
}

function AuditDetail({ entry: e, email }: { entry: AuditEntry; email?: string }) {
  return (
    <div className="space-y-3 text-sm">
      {e.reason && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">{e.outcome === "denied" ? "Blocked by" : "Reason"}</span>
          <DenialReason reason={e.reason} action={e.action} />
        </div>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">When</dt>
        <dd>{fmtExact(e.ts)}</dd>
        <dt className="text-muted-foreground">Actor</dt>
        <dd className="font-mono break-all">
          {e.actorType}
          {e.actorId && ` · ${e.actorId}`}
        </dd>
        {e.accountId && (
          <>
            <dt className="text-muted-foreground">Account</dt>
            <dd className="break-all">{email ?? e.accountId}</dd>
          </>
        )}
        {e.target && (
          <>
            <dt className="text-muted-foreground">Target</dt>
            <dd className="font-mono break-all">{e.target}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Entry</dt>
        <dd className="font-mono">#{e.id}</dd>
      </dl>
      {e.detail && Object.keys(e.detail).length > 0 && <CodeBlock code={JSON.stringify(e.detail, null, 2)} />}
    </div>
  );
}
