import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { AccountsList, ConnectAccountButton } from "@/components/accounts/accounts-list";
import { PageHeader } from "@/components/common";
import { keys } from "@/lib/queries";

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
        description="Mailboxes agentinbox syncs. Credentials stay here; agents get access per account through grants."
        actions={<ConnectAccountButton />}
      />
      <AccountsList />
    </>
  );
}
