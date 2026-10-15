import type { Approval } from "@shared/types";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { TimeAgo } from "@/components/common";
import { Card } from "@/components/ui/card";
import { KIND_LABEL } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { ApprovalStatusBadge, Attachments, BodyPreview, Recipients } from "./approval-parts";

export function ApprovalHistory({ items }: { items: Approval[] }) {
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y">
        {items.map((a) => (
          <HistoryRow key={a.id} approval={a} />
        ))}
      </ul>
    </Card>
  );
}

function HistoryRow({ approval: a }: { approval: Approval }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ApprovalStatusBadge status={a.status} />
            <span>{KIND_LABEL[a.kind]}</span>
            <span aria-hidden>·</span>
            <span className="truncate">
              {a.agentName} via {a.accountEmail}
            </span>
          </div>
          <div className="truncate text-sm font-medium">{a.subject || "(no subject)"}</div>
          {(a.decisionNote || a.error) && (
            <div className={cn("truncate text-xs", a.error ? "text-critical" : "text-muted-foreground")}>{a.error ?? `Note: ${a.decisionNote}`}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <TimeAgo date={a.decidedAt ?? a.expiresAt} />
          <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t bg-muted/20 px-4 py-3">
          {a.reason && (
            <p className="text-sm">
              <span className="text-muted-foreground">Agent's reason: </span>
              {a.reason}
            </p>
          )}
          {a.decisionNote && (
            <p className="text-sm">
              <span className="text-muted-foreground">Your note: </span>
              {a.decisionNote}
            </p>
          )}
          {a.error && <p className="text-sm text-critical">{a.error}</p>}
          <Recipients approval={a} />
          <BodyPreview body={a.body} />
          <Attachments items={a.attachments} />
        </div>
      )}
    </li>
  );
}
