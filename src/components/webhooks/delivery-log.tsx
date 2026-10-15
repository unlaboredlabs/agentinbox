import type { Delivery, DeliveryStatus } from "@shared/types";
import { useInfiniteQuery } from "@tanstack/react-query";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { QueryError, TimeAgo } from "@/components/common";
import { type Columns, DataTable, columnHelper } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { fmtExact, fmtMs } from "@/lib/format";
import { DELIVERY_STATUS } from "@/lib/labels";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { DeliveryStatusBadge, statusCodeTone } from "./webhook-bits";

const col = columnHelper<Delivery>();

export function useReplay() {
  return useApiMutation({
    mutationFn: (d: Delivery) => api<Delivery>(`/api/deliveries/${encodeURIComponent(d.id)}/replay`, { method: "POST" }),
    invalidate: [keys.deliveries, keys.webhooks],
    success: (res) =>
      res.status === "succeeded" ? "Replayed: delivered" : res.status === "pending" ? "Replay queued" : `Replay ${DELIVERY_STATUS[res.status].label.toLowerCase()}`,
    errorTitle: "Couldn't replay",
  });
}

/** Status line + receiver response/error for one delivery. */
export function DeliveryDetail({ delivery: d }: { delivery: Delivery }) {
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Delivery</dt>
        <dd className="font-mono break-all">{d.id}</dd>
        <dt className="text-muted-foreground">Event</dt>
        <dd className="font-mono break-all">
          {d.eventId} · {d.eventType}
        </dd>
        <dt className="text-muted-foreground">First attempt</dt>
        <dd>{fmtExact(d.createdAt)}</dd>
        <dt className="text-muted-foreground">Last update</dt>
        <dd>{fmtExact(d.updatedAt)}</dd>
        {d.nextAttemptAt && d.status === "pending" && (
          <>
            <dt className="text-muted-foreground">Next retry</dt>
            <dd>
              <TimeAgo date={d.nextAttemptAt} />
            </dd>
          </>
        )}
      </dl>
      {d.lastError && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Error</div>
          <pre className="rounded-md border border-critical/30 bg-critical/5 p-2 font-mono text-xs whitespace-pre-wrap break-words">{d.lastError}</pre>
        </div>
      )}
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Response body {d.lastStatusCode != null && `(HTTP ${d.lastStatusCode})`}</div>
        {d.lastResponse ? (
          <pre className="max-h-60 overflow-auto rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words">{d.lastResponse}</pre>
        ) : (
          <p className="text-xs text-muted-foreground italic">Empty</p>
        )}
      </div>
    </div>
  );
}

function ReplayButton({ delivery }: { delivery: Delivery }) {
  const replay = useReplay();
  return (
    <Button variant="ghost" size="sm" disabled={replay.isPending} onClick={() => replay.mutate(delivery)}>
      {replay.isPending ? <Spinner /> : <RotateCcwIcon />}
      <span className="hidden sm:inline">Replay</span>
    </Button>
  );
}

const columns: Columns<Delivery> = [
  col.accessor("status", { header: "Status", cell: (c) => <DeliveryStatusBadge status={c.getValue()} /> }),
  col.accessor("eventType", {
    header: "Event",
    cell: (c) => <code className="font-mono text-xs">{c.getValue()}</code>,
    meta: { className: "hidden md:table-cell" },
  }),
  col.accessor("lastStatusCode", {
    header: "Code",
    cell: (c) => <span className={cn("font-mono tabular", statusCodeTone(c.getValue()))}>{c.getValue() ?? "—"}</span>,
  }),
  col.accessor("attempts", {
    header: "Attempts",
    cell: (c) => <span className="tabular">{c.getValue()}</span>,
    meta: { className: "hidden text-right sm:table-cell" },
  }),
  col.accessor("durationMs", {
    header: "Duration",
    cell: (c) => <span className="text-muted-foreground tabular">{fmtMs(c.getValue())}</span>,
    meta: { className: "hidden text-right sm:table-cell" },
  }),
  col.accessor("updatedAt", { header: "When", cell: (c) => <TimeAgo date={c.getValue()} className="text-xs" /> }),
  col.display({
    id: "replay",
    header: () => <span className="sr-only">Actions</span>,
    cell: (c) => <ReplayButton delivery={c.row.original} />,
    meta: { className: "w-0 text-right" },
  }),
];

export function DeliveryLog({ webhookId }: { webhookId: string }) {
  const [status, setStatus] = useState<DeliveryStatus | undefined>();
  const log = useInfiniteQuery(queries.deliveries(webhookId, status));
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Delivery log</h2>
          <p className="text-sm text-muted-foreground">Every attempt to deliver an event, newest first. Click a row for the response.</p>
        </div>
        <Select value={status ?? "all"} onValueChange={(v) => setStatus(v === "all" ? undefined : (v as DeliveryStatus))}>
          <SelectTrigger className="w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {(Object.keys(DELIVERY_STATUS) as DeliveryStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {DELIVERY_STATUS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {log.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : log.isError ? (
        <QueryError error={log.error} onRetry={() => void log.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={items}
          getRowId={(d) => d.id}
          rowClassName={(d) => (d.status === "dead" || d.status === "failed" ? "bg-critical/5" : undefined)}
          renderExpanded={(d) => <DeliveryDetail delivery={d} />}
          empty={
            status ? (
              <>No {DELIVERY_STATUS[status].label.toLowerCase()} deliveries.</>
            ) : (
              <>
                No deliveries yet. Use <Badge variant="outline">Send test</Badge> to try the endpoint now.
              </>
            )
          }
        />
      )}
      {log.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
            {log.isFetchingNextPage && <Spinner />} Load older deliveries
          </Button>
        </div>
      )}
    </div>
  );
}
