import type { Settings } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { InfoIcon, TimerIcon, ZapIcon } from "lucide-react";
import { PubsubPanel } from "@/components/google/pubsub-panel";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { STEP_META, updateDraft, useSetupProgress } from "./progress";
import { cloudUrl } from "./step-project";
import type { StepProps } from "./step-url";
import { Disclosure, StepCard, StepFooter } from "./wizard-shell";

export function StepPubsub({ index, onBack, onNext }: StepProps) {
  const qc = useQueryClient();
  const { statuses, state, draft } = useSetupProgress();
  const settings = useQuery(queries.settings());
  const accounts = useQuery(queries.accounts());
  const done = statuses.pubsub === "done";
  const shared = draft.projectMode === "existing";
  const workspace = (accounts.data ?? []).some((a) => a.workspaceDomain);
  const interval = settings.data?.pollIntervalSeconds ?? 30;
  const project = state?.gcpProjectId ?? "";

  const polling = useApiMutation({
    mutationFn: async () => {
      if (settings.data?.ingestMode === "pubsub") await api<Settings>("/api/settings", { method: "PATCH", body: { ingestMode: "poll" } });
    },
    invalidate: [keys.settings, keys.setupState, keys.system],
    errorTitle: "Couldn't switch to polling",
    onSuccess: () => {
      updateDraft({ pubsubSkipped: true });
      void qc.invalidateQueries({ queryKey: keys.setupState });
      onNext();
    },
  });

  return (
    <StepCard
      index={index}
      title={STEP_META.pubsub.title}
      description={`Optional. Without this, agentinbox checks for new mail every ${interval} seconds, which works fine. With it, Google tells agentinbox about new mail within seconds.`}
      footer={
        <StepFooter
          onBack={onBack}
          onNext={() => (done ? onNext() : polling.mutate())}
          pending={polling.isPending}
          nextVariant={done ? "default" : "outline"}
          nextLabel={done ? "Continue" : `Skip: check every ${interval} seconds`}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <ZapIcon className="size-4 text-chart-1" aria-hidden /> Within seconds
          </div>
          <p className="text-muted-foreground">
            Uses Google Cloud Pub/Sub, Google's notification service, in your project. agentinbox sets it up for you in one click; works even when
            this machine isn't reachable from the internet. Free for this use.
          </p>
        </div>
        <div className="space-y-1.5 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <TimerIcon className="size-4 text-muted-foreground" aria-hidden /> Every {interval} seconds
            {shared && <Badge variant="secondary">Recommended for a shared project</Badge>}
          </div>
          <p className="text-muted-foreground">Called polling: agentinbox asks Gmail for changes on a timer. Nothing to set up, and the automatic fallback.</p>
        </div>
      </div>

      {shared && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            You reused a project. The Pub/Sub permission agentinbox would ask for reaches every Pub/Sub topic that account can manage, including the
            other apps'. Polling avoids that.
          </span>
        </p>
      )}
      {workspace && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Google Workspace: if your admin set a Google Cloud session length, the Pub/Sub permission makes Google ask you to sign in again regularly.
            An admin can exempt the app (Admin console → Security → Access and data control → Google Cloud session control → mark agentinbox
            trusted and tick “Exempt trusted apps”), or stay on polling.
          </span>
        </p>
      )}

      <PubsubPanel compact />

      <Disclosure summary="Didn't create the Google Cloud project yourself?">
        <p>
          Setting this up needs the project's Owner or Pub/Sub Admin role (Editor isn't enough). Whoever created the project is Owner already. If
          that's someone else, ask them to give your account the Pub/Sub Admin role in IAM, or connect their Gmail account and set up with it.
        </p>
        {project && (
          <a className="text-foreground underline underline-offset-4" href={cloudUrl.iam(project)} target="_blank" rel="noopener noreferrer">
            Open IAM in Google Cloud<span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </Disclosure>
    </StepCard>
  );
}
