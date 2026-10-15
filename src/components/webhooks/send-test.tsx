import type { Delivery } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { SendIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { fmtMs } from "@/lib/format";
import { keys } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { DeliveryDetail } from "./delivery-log";
import { DeliveryStatusBadge, statusCodeTone } from "./webhook-bits";

/** Sends a synthetic event right now and shows exactly what the receiver answered. */
export function SendTest({ webhookId }: { webhookId: string }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<Delivery>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);

  const run = async () => {
    setPending(true);
    setError(undefined);
    try {
      setResult(await api<Delivery>(`/api/webhooks/${encodeURIComponent(webhookId)}/test`, { method: "POST" }));
      void qc.invalidateQueries({ queryKey: keys.deliveries });
      void qc.invalidateQueries({ queryKey: keys.webhooks });
    } catch (err) {
      setResult(undefined);
      setError(err);
    } finally {
      setPending(false);
    }
  };

  const ok = result?.status === "succeeded";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={run} disabled={pending}>
          {pending ? <Spinner /> : <SendIcon />} Send test event
        </Button>
        <span className="text-xs text-muted-foreground">Delivers a sample message.received payload, signed like the real thing.</span>
      </div>
      {error !== undefined && <ErrorAlert error={error} title="Couldn't send the test" />}
      {result && (
        <div className={cn("space-y-3 rounded-lg border p-3", ok ? "border-success/30 bg-success/5" : "border-critical/30 bg-critical/5")}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <DeliveryStatusBadge status={result.status} />
            <span className={cn("font-mono", statusCodeTone(result.lastStatusCode))}>
              {result.lastStatusCode != null ? `HTTP ${result.lastStatusCode}` : "No response"}
            </span>
            <span className="text-muted-foreground">{fmtMs(result.durationMs)}</span>
            <span className="font-medium">{ok ? "Your endpoint accepted it." : "Your endpoint didn't accept it."}</span>
          </div>
          <DeliveryDetail delivery={result} />
        </div>
      )}
    </div>
  );
}
