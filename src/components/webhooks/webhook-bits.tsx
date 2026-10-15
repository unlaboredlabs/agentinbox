import type { Delivery, Webhook } from "@shared/types";
import { TimeAgo, ToneBadge } from "@/components/common";
import { DELIVERY_STATUS } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function DeliveryStatusBadge({ status }: { status: Delivery["status"] }) {
  const s = DELIVERY_STATUS[status];
  return (
    <ToneBadge tone={s.tone} pulse={status === "pending"}>
      {s.label}
    </ToneBadge>
  );
}

export function WebhookStateBadge({ enabled }: { enabled: boolean }) {
  return enabled ? <ToneBadge tone="good">Enabled</ToneBadge> : <ToneBadge tone="idle">Paused</ToneBadge>;
}

/** "12 delivered · 1 failed (24h) · last 3 min ago" */
export function WebhookStats({ webhook: w, className }: { webhook: Webhook; className?: string }) {
  return (
    <span className={cn("flex flex-wrap gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground", className)}>
      <span>Last 24h:</span>
      <span className="tabular">
        <span className="text-foreground">{w.stats.succeeded24h}</span> delivered
      </span>
      <span className={cn("tabular", w.stats.failed24h > 0 && "text-critical")}>
        · <span className={w.stats.failed24h > 0 ? "font-medium" : "text-foreground"}>{w.stats.failed24h}</span> failed
      </span>
      <span>·</span>
      <span>
        Last delivery <TimeAgo date={w.stats.lastDeliveryAt} fallback="never" />
      </span>
    </span>
  );
}

export function statusCodeTone(code: number | null) {
  if (code == null) return "text-muted-foreground";
  if (code >= 200 && code < 300) return "text-success";
  if (code >= 400) return "text-critical";
  return "text-warning";
}
