import type { GoogleClientCheck, SetupWarning } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, CheckCircle2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { CopyField, ExternalLink } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const clientsUrl = (projectId: string | null | undefined) =>
  `https://console.cloud.google.com/auth/clients${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`;

const REDIRECT_CODES = new Set<SetupWarning["code"]>(["redirect_uri_missing", "redirect_uri_changed"]);

/**
 * The server's verdict on the redirect URI (SetupState.warnings): redirect_uri_missing when Google or
 * the imported JSON says it isn't registered, redirect_uri_changed when the public URL changed since
 * the client was saved. Null when neither applies.
 */
export function useRedirectProblem(): SetupWarning | null {
  const client = useQuery(queries.googleClient());
  const state = useQuery(queries.setupState());
  if (!client.data?.clientId) return null;
  return state.data?.warnings?.find((w) => REDIRECT_CODES.has(w.code)) ?? null;
}

/**
 * "Add this redirect URI to your OAuth client": shown in step 4, step 1 after a change, and Settings.
 * After "check now" passes it stays as a confirmation line (focused, so focus doesn't fall to the page).
 * `showStatus`: with no problem, also say whether the client is known to have the URI (step 1 after a change).
 */
export function RedirectNotice({ className, showStatus }: { className?: string; showStatus?: boolean }) {
  const problem = useRedirectProblem();
  const client = useQuery(queries.googleClient());
  const qc = useQueryClient();
  const confirmedRef = useRef<HTMLParagraphElement>(null);
  // Ask Google now: a passing check clears the warning on the server.
  const recheck = useApiMutation({
    mutationFn: () => api<GoogleClientCheck>("/api/google/client/check", { method: "POST" }),
    invalidate: [keys.setupState],
    errorTitle: "Couldn't check the OAuth client",
    success: (c) => (c.redirectUri === "ok" ? "Google confirms the redirect URI is registered" : undefined),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.googleClient }),
  });
  const justConfirmed = !problem && recheck.data?.redirectUri === "ok";
  useEffect(() => {
    if (justConfirmed) confirmedRef.current?.focus();
  }, [justConfirmed]);
  if (!client.data?.clientId) return null;
  if (!problem) {
    if (justConfirmed || (showStatus && client.data.redirectUriConfirmed)) {
      return (
        <p ref={confirmedRef} tabIndex={-1} role="status" className={cn("flex items-center gap-1.5 text-sm text-muted-foreground outline-none", className)}>
          <CheckCircle2Icon className="size-4 shrink-0 text-success" />
          {justConfirmed ? "Google confirms the OAuth client has this redirect URI." : "The OAuth client already has the new redirect URI."}
        </p>
      );
    }
    if (!showStatus) return null;
    return (
      <div className={cn("space-y-1.5 text-sm", className)}>
        <p>Make sure your OAuth client lists the new redirect URI (Google Auth Platform → Clients → your client → Authorized redirect URIs):</p>
        <CopyField value={client.data.redirectUri} label="Copy redirect URI" />
      </div>
    );
  }
  const changed = problem.code === "redirect_uri_changed";
  const result = recheck.data?.redirectUri;
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircleIcon />
      <AlertTitle>{changed ? "Your address changed: add the new redirect URI to the OAuth client" : "The OAuth client is missing this redirect URI"}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-foreground/80">{problem.message}</p>
        <p className="text-foreground/80">
          In Google Cloud: <strong>Google Auth Platform → Clients</strong> → your client → <strong>Authorized redirect URIs</strong> →{" "}
          <strong>Add URI</strong>, paste this, then <strong>Save</strong>. Changes can take a few minutes to apply at Google.
        </p>
        <CopyField value={client.data.redirectUri} label="Copy redirect URI" size="lg" />
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <ExternalLink href={problem.url ?? clientsUrl(client.data.projectId)}>Open Clients in Google Cloud</ExternalLink>
          <Button size="sm" variant="outline" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            {recheck.isPending ? <Spinner /> : <RefreshCwIcon />} I've added it, check now
          </Button>
        </div>
        {result && !recheck.isPending && (
          <p className="text-xs text-foreground/70" role="status">
            {result === "missing"
              ? "Google doesn't list it yet. If you just saved it, wait a minute and check again."
              : result === "unknown"
                ? "Google's answer was unclear. This clears by itself once an account connects through the new address."
                : null}
          </p>
        )}
        {!result && <p className="text-xs text-foreground/70">This also clears by itself once an account connects through it.</p>}
      </AlertDescription>
    </Alert>
  );
}
