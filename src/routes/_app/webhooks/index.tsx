import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/webhooks/")({
  validateSearch: (s: Record<string, unknown>): { new?: string; edit?: string } => ({
    new: typeof s.new === "string" ? s.new : undefined,
    edit: typeof s.edit === "string" ? s.edit : undefined,
  }),
  component: () => <div>Webhooks</div>,
});
