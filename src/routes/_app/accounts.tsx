import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { AccountsList, ConnectAccountButton } from "@/components/accounts/accounts-list";
import { PageHeader } from "@/components/common";
import { CalendarNotice } from "@/components/google/calendar-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { loopbackTwin } from "@/lib/public-url";
import { keys, queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/accounts")({
  // The OAuth callback lands here when it can't hand back to the pop-up's opener.
  validateSearch: (s: Record<string, unknown>): { connected?: string; error?: string } => ({
    // Only an address-shaped value is echoed back; error text from the URL is never shown (anyone can craft the link).
    connected: typeof s.connected === "string" && /^[^\s@<>]{1,64}@[^\s@<>]{1,190}$/.test(s.connected) ? s.connected : undefined,
    error: s.error ? "1" : undefined,
  }),
  component: AccountsPage,
});

function AccountsPage() {
  const { connected, error } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();

  useEffect(() => {
    if (!connected && !error) return;
    if (connected) toast.success(`${connected} is connected`, { description: "Mail starts syncing now." });
    if (error) toast.error("Couldn't connect the account", { description: "Google sign-in didn't complete. Try connecting the account again.", duration: 10_000 });
    void qc.invalidateQueries({ queryKey: keys.accounts });
    void navigate({ search: {}, replace: true });
  }, [connected, error, navigate, qc]);

  return (
    <>
      <PageHeader
        title="Gmail accounts"
        description="Mailboxes (and their Google Calendars, once added) xaq syncs. Credentials stay here; agents get access per account through grants."
        actions={<ConnectAccountButton />}
      />
      <LoopbackTwinHint />
      <CalendarNotice />
      <AccountsList />
    </>
  );
}

/** The console is open at localhost while the saved address is 127.0.0.1 (or the reverse): fine, but say where Google returns. */
function LoopbackTwinHint() {
  const settings = useQuery(queries.settings());
  const here = window.location.origin;
  const twin = settings.data ? loopbackTwin(here, settings.data.publicUrl) : null;
  if (!twin) return null;
  return (
    <Alert variant="info" className="mb-4">
      <InfoIcon />
      <AlertTitle>Google sign-in returns to {twin}</AlertTitle>
      <AlertDescription>
        <p>
          You opened the console at {here}, and its saved address is {twin}. Both reach xaq on this computer and connecting works from
          either. For the smoothest sign-in, open the console at{" "}
          <a href={`${twin}/accounts`} className="font-medium text-foreground underline underline-offset-4">
            {twin}
          </a>{" "}
          (you may need to sign in there once).
        </p>
      </AlertDescription>
    </Alert>
  );
}
