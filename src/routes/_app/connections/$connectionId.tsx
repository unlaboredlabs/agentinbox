import type { HeldToolView, ToolDiffLine } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, CircleCheckIcon, NetworkIcon, PauseIcon, Trash2Icon, UnplugIcon } from "lucide-react";
import { PageHeader, QueryError, TimeAgo, ToneBadge } from "@/components/common";
import { connectionStatusView, hostPort } from "@/components/connections/connection-flow";
import { useConnectionActions, useReconnect } from "@/components/connections/connection-row";
import { hasHidden, HiddenCharsWarning, Visible } from "@/components/hidden-chars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/connections/$connectionId")({
  component: ConnectionPage,
});

function ConnectionPage() {
  const { connectionId } = Route.useParams();
  const navigate = useNavigate();
  const conn = useQuery(queries.connection(connectionId));
  const held = useQuery(queries.heldTools(connectionId));
  const now = useNow(60_000);
  const { askDisable, askRemove } = useConnectionActions();
  const { reconnect, dialog } = useReconnect();

  if (conn.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (conn.isError) return <QueryError error={conn.error} onRetry={() => void conn.refetch()} />;
  const c = conn.data;
  const view = connectionStatusView(c, now);

  return (
    <>
      <Button variant="ghost" size="sm" className="-ml-2 self-start" asChild>
        <Link to="/connections">
          <ArrowLeftIcon /> Connections
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.name} <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
            {c.privateTarget && (
              <Badge variant="outline">
                <NetworkIcon /> Private network: {hostPort(c.privateTarget)}
              </Badge>
            )}
          </span>
        }
        description={view.description}
        actions={
          <>
            <Button variant={view.action === "reconnect" ? "default" : "outline"} onClick={() => reconnect(c)}>
              <UnplugIcon /> Reconnect
            </Button>
            {c.status !== "disabled" && (
              <Button variant="outline" onClick={() => askDisable(c)}>
                <PauseIcon /> Disable
              </Button>
            )}
            <Button variant="outline" className="text-critical" onClick={() => askRemove(c, () => void navigate({ to: "/connections" }))}>
              <Trash2Icon /> Remove
            </Button>
          </>
        }
      />
      {dialog}

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <span>
          Tools as <code className="font-mono text-foreground">{c.slug}__…</code>
        </span>
        <span>
          {c.tools.active} tool{c.tools.active === 1 ? "" : "s"}
        </span>
        <span>
          {c.agents} agent{c.agents === 1 ? "" : "s"}
        </span>
        {c.url && <span className="break-all">{c.url}</span>}
        <span>
          Connected <TimeAgo date={c.createdAt} />
        </span>
      </div>

      <section className="space-y-3" aria-labelledby="held-heading">
        <div>
          <h2 id="held-heading" className="text-lg font-semibold tracking-tight">
            Changed tools
          </h2>
          <p className="text-sm text-muted-foreground">
            agentinbox pinned every tool when you connected. A tool whose definition changes, or a new one, is held: agents can't call it until you
            accept. The other tools keep working.
          </p>
        </div>
        {held.isPending ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : held.isError ? (
          <QueryError error={held.error} onRetry={() => void held.refetch()} />
        ) : held.data.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleCheckIcon className="size-4 text-success" /> No changes. Every tool matches what was pinned.
            </CardContent>
          </Card>
        ) : (
          held.data.map((t) => <HeldToolCard key={t.name} connectionId={c.id} connectionName={c.name} tool={t} />)
        )}
      </section>
    </>
  );
}

function HeldToolCard({ connectionId, connectionName, tool: t }: { connectionId: string; connectionName: string; tool: HeldToolView }) {
  const accept = useApiMutation({
    mutationFn: () => api<HeldToolView[]>(`/api/connections/${encodeURIComponent(connectionId)}/held/${encodeURIComponent(t.name)}/accept`, { body: {} }),
    invalidate: [keys.connections, keys.overview],
    success: `${t.name} is accepted`,
    errorTitle: "Couldn't accept the change",
  });
  const hidden = hasHidden(t.candidate.description, t.candidate.title, JSON.stringify(t.candidate.inputSchema));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 font-mono text-base">
          {t.name}
          <Badge variant="secondary">{t.heldReason === "new" ? "New tool" : "Changed"}</Badge>
        </CardTitle>
        <CardDescription>
          {t.heldReason === "new" ? `${connectionName} added this tool after you connected.` : `${connectionName} changed this tool's definition.`} Noticed{" "}
          <TimeAgo date={t.updatedAt} />. Agents see it as <code className="font-mono">{t.exposedName}</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {hidden && <HiddenCharsWarning what="This definition" />}
        <div className="text-xs font-medium text-muted-foreground">{t.pinned ? "Before (−) and after (+): description, arguments and the rest" : "The new definition"}</div>
        <Diff lines={t.diff} />
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
          {accept.isPending ? <Spinner /> : <CheckIcon />} Accept
        </Button>
      </CardFooter>
    </Card>
  );
}

/** The server's line diff, wrapped (no horizontal scroll), with hidden characters made visible. */
function Diff({ lines }: { lines: ToolDiffLine[] }) {
  if (!lines.length) return <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground italic">(empty)</div>;
  return (
    <pre className="max-h-[70svh] overflow-y-auto rounded-md border bg-muted/30 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
      {lines.map((l, i) => (
        <div key={i} className={cn("px-3", l.op === "+" && "bg-success/10 text-foreground", l.op === "-" && "bg-critical/10 text-muted-foreground line-through")}>
          <span aria-hidden className="mr-2 inline-block w-3 select-none">
            {l.op === "-" ? "−" : l.op}
          </span>
          <span className="sr-only">{l.op === "+" ? "Added: " : l.op === "-" ? "Removed: " : ""}</span>
          <Visible text={l.text} />
        </div>
      ))}
    </pre>
  );
}
