import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, ArrowRightIcon, UnplugIcon } from "lucide-react";
import { ToneBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useBrokerEnabled } from "@/hooks/use-broker";
import { useNow } from "@/hooks/use-now";
import { queries } from "@/lib/queries";
import { connectionStatusView, heldNotices } from "./connection-flow";
import { useReconnect } from "./connection-row";

/** Overview: connections with held tools ("Notion changed 1 tool") and ones that need a reconnect soon. */
export function ConnectionsNotice() {
  const on = useBrokerEnabled();
  const list = useQuery({ ...queries.connections(), enabled: on });
  const now = useNow(60_000);
  const { reconnect, dialog } = useReconnect();
  if (!on || !list.data) return null;
  const held = heldNotices(list.data);
  const fix = list.data
    .map((c) => ({ c, view: connectionStatusView(c, now) }))
    .filter(({ view }) => view.action === "reconnect");
  if (!held.length && !fix.length) return null;
  return (
    <Card className="border-warning/40 bg-warning/[0.06]">
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangleIcon className="size-4 text-warning" />
          {held.length + fix.length === 1 ? "A connection needs you" : "Connections need you"}
        </div>
        <ul className="divide-y">
          {held.map((h) => (
            <li key={`held-${h.id}`} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-48 flex-1 text-sm">
                <div className="font-medium">{h.text}</div>
                <p className="text-xs text-muted-foreground">Changed tools are on hold until you look at the change. The others keep working.</p>
              </div>
              <Button size="sm" asChild>
                <Link to="/connections/$connectionId" params={{ connectionId: h.id }}>
                  Review <ArrowRightIcon />
                </Link>
              </Button>
            </li>
          ))}
          {fix.map(({ c, view }) => (
            <li key={`fix-${c.id}`} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-48 flex-1 text-sm">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {c.name} <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
                </div>
                <p className="text-xs text-muted-foreground">{view.description}</p>
              </div>
              <Button size="sm" onClick={() => reconnect(c)}>
                <UnplugIcon /> Reconnect
              </Button>
            </li>
          ))}
        </ul>
        {dialog}
      </CardContent>
    </Card>
  );
}
