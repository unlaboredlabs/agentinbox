import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { PageHeader, QueryError } from "@/components/common";
import { STEP_IDS, type StepId, useSetupProgress } from "@/components/setup/progress";
import { StepAccounts } from "@/components/setup/step-accounts";
import { StepAgent } from "@/components/setup/step-agent";
import { StepClient } from "@/components/setup/step-client";
import { StepConsent } from "@/components/setup/step-consent";
import { StepProject } from "@/components/setup/step-project";
import { StepPubsub } from "@/components/setup/step-pubsub";
import { type StepProps, StepUrl } from "@/components/setup/step-url";
import { WizardNav } from "@/components/setup/wizard-shell";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_app/get-started")({
  validateSearch: (s: Record<string, unknown>): { step?: StepId } => ({
    step: STEP_IDS.find((id) => id === s.step),
  }),
  component: GetStarted,
});

const STEPS: Record<StepId, (p: StepProps) => React.ReactNode> = {
  url: StepUrl,
  project: StepProject,
  consent: StepConsent,
  client: StepClient,
  accounts: StepAccounts,
  pubsub: StepPubsub,
  agent: StepAgent,
};

/** Resumable setup wizard: opens at the first unfinished step; any step can be revisited. */
function GetStarted() {
  const { step } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const progress = useSetupProgress();

  if (progress.query.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-14 w-72" />
        <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
          <Skeleton className="hidden h-80 lg:block" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }
  if (progress.query.isError) return <QueryError error={progress.query.error} onRetry={() => void progress.query.refetch()} />;

  const current = step ?? progress.firstTodo ?? "agent";
  const index = STEP_IDS.indexOf(current);
  const go = (id: StepId) => {
    void navigate({ search: { step: id } });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const onNext = () => {
    const nextId = STEP_IDS[index + 1];
    if (nextId) go(nextId);
    else {
      toast.success("Setup complete", { description: "Your agents can use Gmail now. The overview shows what they're up to." });
      void navigate({ to: "/" });
    }
  };
  const onBack = index > 0 ? () => go(STEP_IDS[index - 1]!) : undefined;
  const Step = STEPS[current];

  return (
    <>
      <PageHeader
        title="Get started"
        description="About 10 minutes, mostly in Google Cloud. Your progress is saved, so you can leave and pick up where you left off."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[14rem_1fr]">
        <div className="lg:sticky lg:top-20">
          <WizardNav current={current} statuses={progress.statuses} onSelect={go} />
        </div>
        <div className="min-w-0">
          <Step key={current} index={index} onBack={onBack} onNext={onNext} />
        </div>
      </div>
    </>
  );
}
