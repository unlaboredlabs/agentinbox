import { RadioTowerIcon, TimerIcon } from "lucide-react";
import { PubsubPanel } from "@/components/google/pubsub-panel";
import { updateDraft, useSetupProgress } from "./progress";
import type { StepProps } from "./step-url";
import { StepCard, StepFooter } from "./wizard-shell";

export function StepPubsub({ index, onBack, onNext }: StepProps) {
  const { statuses } = useSetupProgress();
  const done = statuses.pubsub === "done";

  return (
    <StepCard
      index={index}
      title="Turn on real-time delivery"
      description="Optional. Decides how fast agents hear about new mail."
      footer={
        <StepFooter
          onBack={onBack}
          onNext={() => {
            if (!done) updateDraft({ pubsubSkipped: true });
            onNext();
          }}
          nextLabel={done ? "Continue" : "Skip, use polling"}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 rounded-lg border p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <RadioTowerIcon className="size-4 text-chart-1" /> Real-time (Pub/Sub)
          </div>
          <p className="text-muted-foreground">
            Gmail announces every change to a Pub/Sub topic in your project within seconds; agentinbox picks it up. Works even when this machine
            isn't reachable from the internet. Needs the Pub/Sub API enabled and project owner/editor rights for the account you connected.
          </p>
        </div>
        <div className="space-y-1.5 rounded-lg border p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <TimerIcon className="size-4 text-muted-foreground" /> Polling
          </div>
          <p className="text-muted-foreground">
            agentinbox asks Gmail for changes on an interval (30 seconds by default). Nothing to set up; new mail just takes a little longer to show up. A perfectly good
            choice, and the automatic fallback.
          </p>
        </div>
      </div>
      <PubsubPanel compact />
    </StepCard>
  );
}
