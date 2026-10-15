import type { WebhookWithSecret } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlusIcon, WebhookIcon } from "lucide-react";
import { useState } from "react";
import { PageHeader, QueryError } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { SecretDialog } from "@/components/webhooks/secret-dialog";
import { WebhookRow } from "@/components/webhooks/webhook-row";
import { WebhookSheet } from "@/components/webhooks/webhook-sheet";
import { useDeliverySpeed } from "@/hooks/use-delivery-speed";
import { intervalInWords } from "@/lib/delivery";
import { queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/webhooks/")({
  // ?new opens the create sheet (its value preselects an agent id; "1" for none).
  validateSearch: (s: Record<string, unknown>): { new?: string } => ({
    new: typeof s.new === "string" && s.new ? s.new : undefined,
  }),
  component: WebhooksPage,
});

function WebhooksPage() {
  const { new: creating } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const webhooks = useQuery(queries.webhooks());
  const agents = useQuery(queries.agents());
  const [created, setCreated] = useState<WebhookWithSecret>();
  const setCreating = (v: string | undefined) => void navigate({ search: { new: v }, replace: true });
  const noAgents = agents.data?.length === 0;
  const { realtime, interval } = useDeliverySpeed();

  const newButton = (
    <Button onClick={() => setCreating("1")} disabled={noAgents}>
      <PlusIcon /> New webhook
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Webhooks"
        description={`Push mail events to your agents ${realtime ? "within seconds of mail arriving" : `within about ${intervalInWords(interval)} of mail arriving`}. Payloads are signed, retried on failure and logged for replay.`}
        actions={newButton}
      />
      {webhooks.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : webhooks.isError ? (
        <QueryError error={webhooks.error} onRetry={() => void webhooks.refetch()} />
      ) : webhooks.data.length === 0 ? (
        <Card>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WebhookIcon />
              </EmptyMedia>
              <EmptyTitle>No webhooks yet</EmptyTitle>
              <EmptyDescription>
                {noAgents
                  ? "Webhooks deliver events to an agent. Create an agent first."
                  : "Add one to have agentinbox call your agent (n8n, a serverless function, your own service) when matching mail arrives."}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {noAgents ? (
                <Button onClick={() => void navigate({ to: "/agents" })}>Go to agents</Button>
              ) : (
                <Button onClick={() => setCreating("1")}>
                  <PlusIcon /> Create a webhook
                </Button>
              )}
            </EmptyContent>
          </Empty>
        </Card>
      ) : (
        <Card className="gap-0 divide-y py-0">
          {webhooks.data.map((w) => (
            <WebhookRow key={w.id} webhook={w} agentName={agents.data?.find((a) => a.id === w.agentId)?.name} agentDisabled={agents.data?.find((a) => a.id === w.agentId)?.disabled} />
          ))}
        </Card>
      )}

      <WebhookSheet
        open={!!creating}
        onOpenChange={(o) => !o && setCreating(undefined)}
        defaultAgentId={creating && creating !== "1" ? creating : undefined}
        onCreated={setCreated}
      />
      <SecretDialog
        secret={created?.secret}
        title={`${created?.webhook.name ?? "Webhook"} created`}
        description="Use this secret to verify that requests really come from agentinbox."
        onClose={() => {
          const id = created?.webhook.id;
          setCreated(undefined);
          if (id) void navigate({ to: "/webhooks/$webhookId", params: { webhookId: id } });
        }}
      />
    </>
  );
}
