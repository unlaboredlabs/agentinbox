import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { QueryError } from "@/components/common";
import { EventRow } from "@/components/events/event-row";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";

export function RecentEvents() {
  const q = useQuery(queries.recentEvents());
  const items = q.data?.items.slice(0, 6) ?? [];
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-3">
        <CardTitle>Recent events</CardTitle>
        <CardDescription>Updates live.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/events">
              All events <ArrowRightIcon />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      {q.isPending ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : q.isError ? (
        <div className="p-4">
          <QueryError error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <p className="border-t px-4 py-8 text-center text-sm text-muted-foreground">No mail events yet. They appear here as mail arrives.</p>
      ) : (
        <ul className="divide-y border-t">
          {items.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </Card>
  );
}
