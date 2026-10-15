import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/webhooks/$webhookId")({
  component: () => <div>Webhook</div>,
});
