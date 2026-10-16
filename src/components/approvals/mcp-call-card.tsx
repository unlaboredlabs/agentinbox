import type { Approval, McpCallApproval, McpCallApprovalView, McpCallApproveInput } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, BotIcon, CheckCheckIcon, CheckIcon, LinkIcon, MailIcon, MessageSquareQuoteIcon, PlugIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { QueryError, TimeAgo } from "@/components/common";
import { HiddenCharsWarning } from "@/components/hidden-chars";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError, toastError } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ExpiryCountdown } from "./approval-parts";
import { alwaysAllowFor, argsHaveInvisible, cardWarnings, escapeInvisible, hasInvisible, isCallView, type McpDecision, type TargetChoice, targetChoices } from "./mcp-call";

/** Approve / Always allow / Reject for an mcp.call, with the optional "only for this target" scope. */
export function useMcpDecision(view: McpCallApprovalView, onDecided?: (res: Approval, d: McpDecision) => void) {
  const qc = useQueryClient();
  const a = view.approval;
  const choices = targetChoices(view);
  // The tool's own target is preselected; a generic tool's argument is the reviewer's pick (none by default).
  const [target, setTarget] = useState<TargetChoice | null>(choices[0]?.own ? choices[0] : null);
  const decide = useMutation({
    mutationFn: async (d: McpDecision) => {
      const body: McpCallApproveInput = d === "always" ? { alwaysAllow: alwaysAllowFor(target) } : {};
      try {
        return await api<Approval>(`/api/approvals/${encodeURIComponent(a.id)}/${d === "reject" ? "reject" : "approve"}`, { body });
      } catch (err) {
        // A double tap (or another tab) already decided it: 409. Show what happened instead of an error.
        if (!(err instanceof ApiError) || err.status !== 409) throw err;
        const fresh = await api<McpCallApprovalView | Approval>(`/api/approvals/${encodeURIComponent(a.id)}`);
        if (!isCallView(fresh) || fresh.approval.status === "pending") throw err;
        return fresh.approval;
      }
    },
    onSuccess: (res, d) => {
      if (res.status !== "pending") qc.setQueryData<Approval[]>([...keys.approvals, "pending"], (list) => list?.filter((x) => x.id !== a.id));
      for (const k of [keys.approvals, keys.overview, keys.approvalRules]) void qc.invalidateQueries({ queryKey: k });
      onDecided?.(res, d);
    },
    onError: (err) => toastError(err, "Couldn't record the decision"),
  });
  return { decide, choices, target, setTarget };
}

/** The call to decide on: tool and connection, recipients and URLs first, then the exact arguments. */
export function McpCallBody({ view: v, showReason = true, uncapped }: { view: McpCallApprovalView; showReason?: boolean; /** The one-tap page: the whole call, no inner scroll box (nothing hides below the sticky buttons). */ uncapped?: boolean }) {
  const a = v.approval;
  const warnings = a.status === "pending" ? cardWarnings(v) : [];
  const hidden = argsHaveInvisible(a.call.args) || (!!a.reason && hasInvisible(a.reason));
  const lines = v.pretty.split("\n").length;
  return (
    <div className="space-y-4">
      {warnings.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{warnings[0]}</AlertTitle>
          {warnings.length > 1 && (
            <AlertDescription>
              {warnings.slice(1).map((w) => (
                <p key={w}>{w}</p>
              ))}
            </AlertDescription>
          )}
        </Alert>
      )}
      {hidden && <HiddenCharsWarning what="This call" />}
      {a.call.outcomeUnknown && (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>May have run: outcome unknown</AlertTitle>
          <AlertDescription>The approved call was interrupted, so it may or may not have run. agentinbox won't retry it.</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <PlugIcon className="size-4 text-muted-foreground" />
        <span className="font-mono font-medium break-all">{a.call.tool}</span>
        <span className="text-muted-foreground">on</span>
        <span className="font-medium">{v.connection?.name ?? "a removed connection"}</span>
        {v.tool?.title && <span className="text-muted-foreground">({escapeInvisible(v.tool.title, true)})</span>}
      </div>
      {showReason && a.reason && (
        <div className="flex gap-2 rounded-lg border-l-2 border-chart-1 bg-chart-1/5 px-3 py-2 text-sm">
          <MessageSquareQuoteIcon className="mt-0.5 size-4 shrink-0 text-chart-1" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-muted-foreground">Agent's reason</div>
            <p className="break-words whitespace-pre-wrap">
              {escapeInvisible(a.reason)}
            </p>
          </div>
        </div>
      )}
      {(v.recipients.length > 0 || v.urls.length > 0) && (
        <dl className="space-y-2 text-sm">
          {v.recipients.length > 0 && (
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MailIcon className="size-3.5" /> Recipients
              </dt>
              <dd className="mt-1 space-y-0.5">
                {v.recipients.map((r) => (
                  <div key={r} className="font-mono text-[13px] break-all">
                    {escapeInvisible(r, true)}
                  </div>
                ))}
              </dd>
            </div>
          )}
          {v.urls.length > 0 && (
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <LinkIcon className="size-3.5" /> Links
              </dt>
              <dd className="mt-1 space-y-0.5">
                {v.urls.map((u) => (
                  <div key={u} className="font-mono text-[13px] break-all">
                    {escapeInvisible(u, true)}
                  </div>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">
          Exact arguments{!uncapped && lines > 20 ? ` (${lines} lines, scroll to see all)` : ""}
        </div>
        <ArgsJson text={v.pretty} uncapped={uncapped} />
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={a.call.argsSha256}>
          sha256 {a.call.argsSha256}
        </div>
      </div>
    </div>
  );
}

/** Pretty JSON, wrapped (never a horizontal scrollbar), with the \u escapes the server added for invisible characters highlighted. */
function ArgsJson({ text, uncapped }: { text: string; uncapped?: boolean }) {
  // Anything else the server escaped is still a \u sequence; escapeInvisible is a no-op safety net on top.
  const parts = escapeInvisible(text).split(/(\\u[0-9A-Fa-f]{4})/);
  return (
    <pre className={cn(!uncapped && "max-h-[60svh] overflow-y-auto", "rounded-lg border bg-muted/30 p-3 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere]")}>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} title="Invisible or control character" className="rounded-sm bg-critical/15 px-0.5 text-critical">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </pre>
  );
}

const ANY = "__any__";

/** Approve / Always allow this (+ "only for <target>") / Reject. `large`: the one-tap page's full-width buttons. */
export function McpDecisionButtons({ view: v, d, large }: { view: McpCallApprovalView; d: ReturnType<typeof useMcpDecision>; large?: boolean }) {
  const pending = d.decide.isPending ? d.decide.variables : undefined;
  const size = large ? "lg" : "default";
  return (
    <div className={cn("w-full space-y-3")}>
      {d.choices[0]?.own ? (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={!!d.target} onCheckedChange={(c) => d.setTarget(c === true ? d.choices[0]! : null)} />
          <span className="min-w-0 break-words">
            {d.choices[0].label} <span className="text-muted-foreground">(for “Always allow this”)</span>
          </span>
        </label>
      ) : d.choices.length > 0 ? (
        <div className="space-y-1 text-sm">
          <label htmlFor={`always-${v.approval.id}`} className="text-muted-foreground">
            “Always allow this” applies to
          </label>
          <Select value={d.target?.path ?? ANY} onValueChange={(p) => d.setTarget(d.choices.find((c) => c.path === p) ?? null)}>
            <SelectTrigger id={`always-${v.approval.id}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any call to {v.approval.call.tool}</SelectItem>
              {d.choices.map((c) => (
                <SelectItem key={c.path} value={c.path}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
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

/** A pending mcp.call in the approvals list: its card comes from GET /api/approvals/:id. */
export function McpCallCard({ approval: a }: { approval: McpCallApproval }) {
  const view = useQuery(queries.approval(a.id));
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
            <span className="font-medium">{(view.data && isCallView(view.data) && view.data.connection?.name) || "a connection"}</span>
            <Badge variant="secondary">Tool call</Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <TimeAgo date={a.createdAt} />
            <ExpiryCountdown expiresAt={a.expiresAt} />
          </div>
        </div>
      </CardHeader>
      {view.isPending ? (
        <CardContent>
          <Skeleton className="h-40" />
        </CardContent>
      ) : view.isError ? (
        <CardContent>
          <QueryError error={view.error} onRetry={() => void view.refetch()} />
        </CardContent>
      ) : (
        isCallView(view.data) ? <Decidable view={view.data} /> : <CardContent className="text-sm text-muted-foreground">This request changed kind; reload the page.</CardContent>
      )}
    </Card>
  );
}

/** A decided mcp.call's details in the history list (fetched when the row opens). */
export function McpCallHistoryBody({ id }: { id: string }) {
  const view = useQuery(queries.approval(id));
  if (view.isPending) return <Skeleton className="h-24" />;
  if (view.isError) return <QueryError error={view.error} onRetry={() => void view.refetch()} />;
  return isCallView(view.data) ? <McpCallBody view={view.data} showReason={false} /> : null;
}

function Decidable({ view }: { view: McpCallApprovalView }) {
  const name = `${view.approval.call.tool} on ${view.connection?.name ?? "the connection"}`;
  const d = useMcpDecision(view, (res, decision) => {
    if (decision === "reject") toast.success("Rejected", { description: "Nothing ran. The agent is told you rejected it." });
    else if (res.status === "pending") toast.error("It didn't run", { description: res.error ?? undefined });
    else if (res.status === "failed" && res.kind === "mcp.call" && res.call.outcomeUnknown)
      toast.error("Outcome unknown", { description: "The call was interrupted: it may or may not have run. It won't be retried." });
    else if (res.status === "failed") toast.error("Approved, but the call failed", { description: res.error ?? undefined });
    else if (res.status === "rejected") toast.error("It couldn't run", { description: res.error ?? undefined });
    else toast.success(decision === "always" ? "Approved, and always allowed" : "Approved", { description: `${name} ran.` });
  });
  return (
    <>
      <CardContent>
        <McpCallBody view={view} />
      </CardContent>
      <CardFooter className="border-t">
        <McpDecisionButtons view={view} d={d} />
      </CardFooter>
    </>
  );
}
