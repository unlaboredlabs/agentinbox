import { createFileRoute } from "@tanstack/react-router";
import { STEP_IDS, type StepId } from "@/components/setup/progress";

export const Route = createFileRoute("/_app/get-started")({
  validateSearch: (s: Record<string, unknown>): { step?: StepId } => ({
    step: STEP_IDS.find((id) => id === s.step),
  }),
  component: () => <div>Get started</div>,
});
