import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { QueryError } from "@/components/common";
import { WebhookStateBadge, WebhookStats } from "@/components/webhooks/webhook-bits";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";

export function AgentWebhooks({ agentId }: { agentId: string }) {
  const q = useQuery(queries.webhooks(agentId));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <CardDescription>Push mail events to this agent as they happen, instead of it polling for them.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" asChild>
            <Link to="/webhooks" search={{ new: agentId }}>
              <PlusIcon /> Add webhook
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {q.isPending ? (
          <Skeleton className="h-14" />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No webhooks. The agent can still pull events with the <code className="font-mono text-foreground">wait_for_events</code> MCP tool.
          </p>
        ) : (
          <ul className="-mx-2 divide-y">
            {q.data.map((w) => (
              <li key={w.id}>
                <Link
                  to="/webhooks/$webhookId"
                  params={{ webhookId: w.id }}
                  className="flex items-center gap-3 rounded-md px-2 py-2.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{w.name}</span>
                      <WebhookStateBadge enabled={w.enabled} />
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{w.url}</div>
                    <WebhookStats webhook={w} />
                  </div>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
