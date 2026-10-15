import type { GoogleClientCheck, SetupWarning } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { CopyField, ExternalLink } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";

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

/** "Add this redirect URI to your OAuth client": shown in step 4, step 1 after a change, and Settings. */
export function RedirectNotice({ className }: { className?: string }) {
  const problem = useRedirectProblem();
  const client = useQuery(queries.googleClient());
  const qc = useQueryClient();
  // Ask Google now: a passing check clears the warning on the server.
  const recheck = useApiMutation({
    mutationFn: () => api<GoogleClientCheck>("/api/google/client/check", { method: "POST" }),
    invalidate: [keys.setupState],
    errorTitle: "Couldn't check the OAuth client",
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.googleClient }),
  });
  if (!problem || !client.data) return null;
  const changed = problem.code === "redirect_uri_changed";
  const result = recheck.data?.redirectUri;
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircleIcon />
      <AlertTitle>{changed ? "Your address changed: add the new redirect URI to the OAuth client" : "The OAuth client is missing this redirect URI"}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-foreground/80">
          {problem.message} Until it's added, Google shows "Error 400: redirect_uri_mismatch" when you connect an account.
        </p>
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
