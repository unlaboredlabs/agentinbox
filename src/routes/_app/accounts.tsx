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
    connected: typeof s.connected === "string" ? s.connected : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
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
    if (error) toast.error("Couldn't connect the account", { description: error, duration: 10_000 });
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
