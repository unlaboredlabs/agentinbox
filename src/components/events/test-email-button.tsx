import type { Account, TestEmailResult } from "@shared/types";
import { SendIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, describeError } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * "Send a test email": xaq mails the account from itself (POST /api/accounts/:id/test-email),
 * which shows up as a new event within moments. Errors (paused account, rate limit) are shown inline.
 */
export function TestEmailButton({ accounts, className }: { accounts: Account[]; className?: string }) {
  const usable = accounts.filter((a) => a.status === "active");
  const [picked, setPicked] = useState<string>();
  const accountId = picked ?? usable[0]?.id;
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent" } | { kind: "error"; text: string }>({ kind: "idle" });
  const id = useId();
  if (!usable.length) return null;

  const send = async () => {
    if (!accountId) return;
    setState({ kind: "sending" });
    try {
      await api<TestEmailResult>(`/api/accounts/${encodeURIComponent(accountId)}/test-email`, { method: "POST" });
      setState({ kind: "sent" });
    } catch (err) {
      const { message, hint } = describeError(err);
      setState({ kind: "error", text: hint ? `${message} ${hint}` : message });
    }
  };

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {usable.length > 1 && (
          <>
            <label htmlFor={id} className="sr-only">
              Account to send from
            </label>
            <Select value={accountId} onValueChange={setPicked}>
              <SelectTrigger id={id} className="w-auto min-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {usable.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Button variant="outline" onClick={() => void send()} disabled={state.kind === "sending"}>
          {state.kind === "sending" ? <Spinner /> : <SendIcon />} Send a test email
        </Button>
      </div>
      <p role="status" className={cn("text-xs", state.kind === "error" ? "text-destructive" : "text-muted-foreground")}>
        {state.kind === "sent"
          ? "Sent. It shows up here within moments."
          : state.kind === "error"
            ? state.text
            : `From ${usable.length === 1 ? usable[0]!.email : "the account"} to itself; nobody else gets it.`}
      </p>
    </div>
  );
}
