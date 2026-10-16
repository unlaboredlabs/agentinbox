import type { Approval } from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BotIcon, CheckCheckIcon, CheckIcon, LinkIcon, MailIcon, MessageSquareQuoteIcon, PlugIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { TimeAgo } from "@/components/common";
import { HiddenCharsWarning, Visible } from "@/components/hidden-chars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { api, toastError } from "@/lib/api";
import { type BrokerApproval, keys, type McpCallDetail } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ExpiryCountdown } from "./approval-parts";
import { argHighlights, argsHaveInvisible, escapeInvisible, hasInvisible, type McpDecision, prettyJson, targetLabel } from "./mcp-call";

export type McpApproval = BrokerApproval & { kind: "mcp.call"; mcp: McpCallDetail };

/** Approve / Always allow / Reject for an mcp.call, with the optional "only for this target" scope. */
export function useMcpDecision(a: McpApproval, onDecided?: (res: BrokerApproval, d: McpDecision) => void) {
  const qc = useQueryClient();
  const [onlyTarget, setOnlyTarget] = useState(!!a.mcp.target);
  const decide = useMutation({
    mutationFn: (d: McpDecision) =>
      api<BrokerApproval>(`/api/approvals/${encodeURIComponent(a.id)}/${d === "reject" ? "reject" : "approve"}`, {
        body: d === "always" ? { alwaysAllow: { target: !!a.mcp.target && onlyTarget } } : {},
      }),
    onSuccess: (res, d) => {
      qc.setQueryData<Approval[]>([...keys.approvals, "pending"], (list) => list?.filter((x) => x.id !== a.id));
      for (const k of [keys.approvals, keys.overview, keys.approvalRules]) void qc.invalidateQueries({ queryKey: k });
      onDecided?.(res, d);
    },
    onError: (err) => toastError(err, "Couldn't record the decision"),
  });
  return { decide, onlyTarget, setOnlyTarget };
}

/** The call to decide on: tool and connection, recipients and URLs first, then the exact arguments. */
export function McpCallBody({ approval: a }: { approval: McpApproval }) {
  const m = a.mcp;
  const highlights = argHighlights(m.argsJson);
  const recipients = highlights.filter((h) => h.kind === "recipient");
  const urls = highlights.filter((h) => h.kind === "url");
  const hidden = argsHaveInvisible(m.argsJson) || (!!a.reason && hasInvisible(a.reason));
  return (
    <div className="space-y-4">
      {hidden && <HiddenCharsWarning what="This call" />}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <PlugIcon className="size-4 text-muted-foreground" />
        <span className="font-mono font-medium break-all">{m.tool}</span>
        <span className="text-muted-foreground">on</span>
        <span className="font-medium">{m.connectionName}</span>
      </div>
      {a.reason && (
        <div className="flex gap-2 rounded-lg border-l-2 border-chart-1 bg-chart-1/5 px-3 py-2 text-sm">
          <MessageSquareQuoteIcon className="mt-0.5 size-4 shrink-0 text-chart-1" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-muted-foreground">Agent's reason</div>
            <p className="break-words whitespace-pre-wrap">
              <Visible text={a.reason} />
            </p>
          </div>
        </div>
      )}
      {(recipients.length > 0 || urls.length > 0) && (
        <dl className="space-y-2 text-sm">
          {recipients.length > 0 && (
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MailIcon className="size-3.5" /> Recipients
              </dt>
              <dd className="mt-1 space-y-0.5">
                {recipients.map((r) => (
                  <div key={r.value} className="font-mono text-[13px] break-all">
                    {escapeInvisible(r.value)} <span className="text-xs text-muted-foreground">({r.path})</span>
                  </div>
                ))}
              </dd>
            </div>
          )}
          {urls.length > 0 && (
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <LinkIcon className="size-3.5" /> Links
              </dt>
              <dd className="mt-1 space-y-0.5">
                {urls.map((u) => (
                  <div key={u.value} className="font-mono text-[13px] break-all">
                    {escapeInvisible(u.value)} <span className="text-xs text-muted-foreground">({u.path})</span>
                  </div>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Exact arguments</div>
        <ArgsJson raw={m.argsJson} />
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={m.argsSha256}>
          sha256 {m.argsSha256}
        </div>
      </div>
    </div>
  );
}

/** Pretty JSON, wrapped (never a horizontal scrollbar), with escapes for invisible characters highlighted. */
function ArgsJson({ raw }: { raw: string }) {
  const text = prettyJson(raw);
  // Every \uXXXX escape stands for a character that would otherwise be invisible (or a control): mark them all.
  const parts = text.split(/(\\u[0-9A-Fa-f]{4})/);
  return (
    <pre className="max-h-[60svh] overflow-y-auto rounded-lg border bg-muted/30 p-3 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} title="Invisible character" className="rounded-sm bg-critical/15 px-0.5 text-critical">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </pre>
  );
}

/** Approve / Always allow this (+ "only for <target>") / Reject. `large`: the one-tap page's full-width buttons. */
export function McpDecisionButtons({ approval: a, d, large }: { approval: McpApproval; d: ReturnType<typeof useMcpDecision>; large?: boolean }) {
  const pending = d.decide.isPending ? d.decide.variables : undefined;
  const size = large ? "lg" : "default";
  return (
    <div className={cn("w-full space-y-3", !large && "sm:w-auto")}>
      {a.mcp.target && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={d.onlyTarget} onCheckedChange={(c) => d.setOnlyTarget(c === true)} />
          <span className="min-w-0 break-words">
            {targetLabel(a.mcp.target)} <span className="text-muted-foreground">(for “Always allow this”)</span>
          </span>
        </label>
      )}
      <div className={cn("flex gap-2", large ? "flex-col" : "flex-col-reverse sm:flex-row sm:justify-end")}>
        <Button size={size} variant="outline" disabled={d.decide.isPending} onClick={() => d.decide.mutate("reject")} className={cn(large && "order-3")}>
          {pending === "reject" ? <Spinner /> : <XIcon />} Reject
        </Button>
        <Button size={size} variant="secondary" disabled={d.decide.isPending} onClick={() => d.decide.mutate("always")} className={cn(large && "order-2")}>
          {pending === "always" ? <Spinner /> : <CheckCheckIcon />} Always allow this
        </Button>
        <Button size={size} disabled={d.decide.isPending} onClick={() => d.decide.mutate("approve")} className={cn(large && "order-1")}>
          {pending === "approve" ? <Spinner /> : <CheckIcon />} Approve
        </Button>
      </div>
    </div>
  );
}

/** A pending mcp.call in the approvals list. */
export function McpCallCard({ approval: a }: { approval: McpApproval }) {
  const d = useMcpDecision(a, (res, decision) => {
    if (decision === "reject") toast.success("Rejected", { description: "Nothing ran. The agent is told you rejected it." });
    else if (res.status === "failed") toast.error("Approved, but the call failed", { description: res.error ?? undefined });
    else toast.success(decision === "always" ? "Approved, and always allowed" : "Approved", { description: `${a.mcp.tool} on ${a.mcp.connectionName} ran.` });
  });
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Link to="/agents/$agentId" params={{ agentId: a.agentId }} className="flex items-center gap-1.5 font-medium hover:underline">
              <BotIcon className="size-4 text-muted-foreground" />
              {a.agentName}
            </Link>
            <span className="text-muted-foreground">wants to use</span>
            <span className="font-medium">{a.mcp.connectionName}</span>
            <Badge variant="secondary">Tool call</Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <TimeAgo date={a.createdAt} />
            <ExpiryCountdown expiresAt={a.expiresAt} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <McpCallBody approval={a} />
      </CardContent>
      <CardFooter className="border-t">
        <McpDecisionButtons approval={a} d={d} />
      </CardFooter>
    </Card>
  );
}
