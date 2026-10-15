import type { AgentTestResult } from "@shared/types";
import { CheckCircle2Icon, PlugZapIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Runs MCP initialize + tools/list as the agent, inside the server. Proves the key's access and the
 * tool list, not that the agent's own tool is configured (that shows as its first real call).
 */
export function TestConnection({ agentId, className }: { agentId: string; className?: string }) {
  const [result, setResult] = useState<AgentTestResult>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);

  const run = async () => {
    setPending(true);
    setError(undefined);
    try {
      setResult(await api<AgentTestResult>(`/api/agents/${encodeURIComponent(agentId)}/test`, { method: "POST" }));
    } catch (err) {
      setResult(undefined);
      setError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={run} disabled={pending} aria-describedby={`test-${agentId}-hint`}>
          {pending ? <Spinner /> : <PlugZapIcon />} Check key and tools (from the server)
        </Button>
        <span id={`test-${agentId}-hint`} className="text-xs text-muted-foreground">
          Lists the tools this agent's access allows, as seen from the server. It doesn't reach your agent: that shows above once it calls
          agentinbox.
        </span>
      </div>
      {error !== undefined && <ErrorAlert error={error} title="Check failed" />}
      <div role="status" aria-live="polite">
        {result && (
          <div className={cn("space-y-2 rounded-lg border p-3", result.ok ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5")}>
            <div className="flex items-center gap-2 text-sm font-medium">
              {result.ok ? <CheckCircle2Icon className="size-4 text-success" /> : <XCircleIcon className="size-4 text-destructive" />}
              {result.message}
            </div>
            {result.tools.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">{result.tools.length} tools available to this agent:</div>
                <div className="flex flex-wrap gap-1">
                  {result.tools.map((t) => (
                    <Badge key={t} variant="secondary" className="font-mono font-normal">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
