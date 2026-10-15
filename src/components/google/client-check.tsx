import type { GoogleClientCheck, GoogleClientView } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, CircleHelpIcon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { keys } from "@/lib/queries";
import { cn } from "@/lib/utils";

type Row = { label: string; status: "ok" | "bad" | "unknown"; text: string };

function rows(c: GoogleClientCheck, v: GoogleClientView | undefined): Row[] {
  const secret = v?.secretHint ? ` (ending in …${v.secretHint})` : "";
  return [
    {
      label: "Client ID",
      status: c.clientId === "ok" ? "ok" : c.clientId === "invalid" ? "bad" : "unknown",
      text:
        c.clientId === "ok"
          ? "Google knows this client."
          : c.clientId === "invalid"
            ? "Google doesn't know this client ID: it was deleted, mistyped, or belongs to another project. Create a new client and import it."
            : "Couldn't tell. Connecting an account will show it.",
    },
    {
      label: "Redirect URI",
      status: c.redirectUri === "ok" ? "ok" : c.redirectUri === "missing" ? "bad" : "unknown",
      text:
        c.redirectUri === "ok"
          ? "Registered on the client."
          : c.redirectUri === "missing"
            ? "Not registered yet (see above). Google applies changes within a few minutes: check again after adding it."
            : "Couldn't tell. Connecting an account will show it.",
    },
    {
      label: "Secret",
      status: c.secret === "ok" ? "ok" : c.secret === "invalid" ? "bad" : "unknown",
      text:
        c.secret === "ok"
          ? `Accepted by Google${secret}.`
          : c.secret === "invalid"
            ? `Google rejects the saved secret${secret}. Open the client in Google Cloud, click Add secret, and enter the new one by hand below.`
            : "Couldn't tell. Connecting an account will show it.",
    },
  ];
}

const ICON = { ok: CheckCircle2Icon, bad: XCircleIcon, unknown: CircleHelpIcon };
const COLOR = { ok: "text-success", bad: "text-critical", unknown: "text-muted-foreground" };

/** What Google said about the saved client (POST /api/google/client/check), with "Check again". */
export function ClientCheckResult({
  check,
  view,
  onChecked,
}: {
  check: GoogleClientCheck | undefined;
  view: GoogleClientView | undefined;
  onChecked: (c: GoogleClientCheck) => void;
}) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async () => {
    setPending(true);
    setError(undefined);
    try {
      onChecked(await api<GoogleClientCheck>("/api/google/client/check", { method: "POST" }));
      void qc.invalidateQueries({ queryKey: keys.setupState });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2" role="status" aria-live="polite">
      {check && (
        <dl className="divide-y rounded-lg border text-sm">
          {rows(check, view).map((r) => {
            const Icon = ICON[r.status];
            return (
              <div key={r.label} className="flex items-start gap-2.5 px-3 py-2">
                <Icon className={cn("mt-0.5 size-4 shrink-0", COLOR[r.status])} aria-hidden />
                <dt className="w-24 shrink-0 font-medium text-foreground">{r.label}</dt>
                <dd className="min-w-0 flex-1 text-muted-foreground">{r.text}</dd>
              </div>
            );
          })}
        </dl>
      )}
      {error !== undefined && <ErrorAlert error={error} title="Couldn't check the client" />}
      <Button size="sm" variant="outline" onClick={run} disabled={pending}>
        {pending ? <Spinner /> : <RefreshCwIcon />} {check ? "Check again" : "Check the client with Google"}
      </Button>
    </div>
  );
}
