import type { GoogleClientView, SetupWarning } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, CheckIcon } from "lucide-react";
import { CopyField, ExternalLink } from "@/components/common";
import { updateDraft, useSetupDraft } from "@/components/setup/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { queries } from "@/lib/queries";

export const clientsUrl = (projectId: string | null | undefined) =>
  `https://console.cloud.google.com/auth/clients${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`;

export type RedirectProblem =
  | { kind: "server"; uri: string; warning: SetupWarning }
  | { kind: "changed"; uri: string; previous: string };

/**
 * Is the redirect URI Google has on file (as far as we know) different from the one agentinbox uses now?
 * The server knows when an imported JSON didn't list it (redirect_uri_missing); this browser also
 * remembers the URI the client was saved with, which catches a public URL change after manual entry.
 */
export function useRedirectProblem(): RedirectProblem | null {
  const client = useQuery(queries.googleClient());
  const state = useQuery(queries.setupState());
  const draft = useSetupDraft();
  const v = client.data;
  if (!v?.clientId) return null;
  const warning = state.data?.warnings?.find((w) => w.code === "redirect_uri_missing");
  if (warning) return { kind: "server", uri: v.redirectUri, warning };
  if (draft.clientRedirectUri && draft.clientRedirectUri !== v.redirectUri) return { kind: "changed", uri: v.redirectUri, previous: draft.clientRedirectUri };
  return null;
}

/** Remember the redirect URI the client was registered with (call after saving or importing a client). */
export const rememberClientRedirect = (v: Pick<GoogleClientView, "redirectUri">) => updateDraft({ clientRedirectUri: v.redirectUri });

/**
 * Before a public URL change is saved: keep the old redirect URI as "what the client has", so the
 * notice can ask for the new one. No-op when no client is saved or one is already remembered.
 */
export function rememberRedirectBeforeChange(v: GoogleClientView | undefined, draftUri: string | undefined) {
  if (v?.clientId && !draftUri) updateDraft({ clientRedirectUri: v.redirectUri });
}

/** "Add this redirect URI to your OAuth client": shown in step 4, step 1 after a change, and Settings. */
export function RedirectNotice({ className }: { className?: string }) {
  const problem = useRedirectProblem();
  const client = useQuery(queries.googleClient());
  if (!problem) return null;
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircleIcon />
      <AlertTitle>
        {problem.kind === "changed" ? "Your address changed: add the new redirect URI to the OAuth client" : "The OAuth client is missing this redirect URI"}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-foreground/80">
          {problem.kind === "changed"
            ? `It was registered with ${problem.previous}. Until the new one is added, Google shows "Error 400: redirect_uri_mismatch" when you connect an account.`
            : problem.warning.message}
        </p>
        <p className="text-foreground/80">
          In Google Cloud: <strong>Google Auth Platform → Clients</strong> → your client → <strong>Authorized redirect URIs</strong> →{" "}
          <strong>Add URI</strong>, paste this, then <strong>Save</strong>. Changes can take a few minutes to apply at Google.
        </p>
        <CopyField value={problem.uri} label="Copy redirect URI" size="lg" />
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <ExternalLink href={clientsUrl(client.data?.projectId)}>Open Clients in Google Cloud</ExternalLink>
          {problem.kind === "changed" && (
            <Button size="sm" variant="outline" onClick={() => updateDraft({ clientRedirectUri: problem.uri })}>
              <CheckIcon /> I've added it
            </Button>
          )}
        </div>
        {problem.kind === "server" && (
          <p className="text-xs text-foreground/70">This clears by itself once an account connects, or re-import the client's JSON to re-check now.</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
