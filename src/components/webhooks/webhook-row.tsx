import type { Webhook } from "@shared/types";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EVENT_TYPE_INFO } from "@/lib/labels";
import { WebhookStateBadge, WebhookStats } from "./webhook-bits";

export function WebhookRow({ webhook: w, agentName }: { webhook: Webhook; agentName?: string }) {
  return (
    <Link
      to="/webhooks/$webhookId"
      params={{ webhookId: w.id }}
      className="flex items-center gap-3 p-4 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{w.name}</span>
          <WebhookStateBadge enabled={w.enabled} />
          {agentName && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <BotIcon className="size-3.5" /> {agentName}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">{w.url}</div>
        <div className="flex flex-wrap gap-1">
          {w.eventTypes.map((t) => (
            <Badge key={t} variant="outline" className="font-normal">
              {EVENT_TYPE_INFO[t]?.label ?? t}
            </Badge>
          ))}
        </div>
        <WebhookStats webhook={w} />
      </div>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
