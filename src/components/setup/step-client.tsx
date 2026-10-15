import { useQuery } from "@tanstack/react-query";
import { CheckCircle2Icon, InfoIcon } from "lucide-react";
import { CopyField, ErrorAlert } from "@/components/common";
import { ClientForm } from "@/components/google/client-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";
import { useSetupProgress } from "./progress";
import { cloudUrl } from "./step-project";
import type { StepProps } from "./step-url";
import { CloudLink, Guide, GuideStep, StepCard, StepFooter } from "./wizard-shell";

export function StepClient({ index, onBack, onNext }: StepProps) {
  const { state, draft } = useSetupProgress();
  const client = useQuery(queries.googleClient());
  const project = draft.projectId ?? state?.gcpProjectId ?? client.data?.projectId ?? "";
  const appType = draft.appType ?? state?.googleAppType ?? client.data?.appType ?? undefined;
  const configured = !!client.data?.clientId && !!client.data.hasSecret;
  const v = client.data;

  return (
    <StepCard
      index={index}
      title="Create the OAuth client"
      description="The client is how agentinbox identifies itself to Google when you connect a mailbox."
      footer={<StepFooter onBack={onBack} onNext={onNext} nextDisabled={!configured} hint={!configured ? "Save the client first" : undefined} />}
    >
      {client.isPending ? (
        <Skeleton className="h-64" />
      ) : client.isError ? (
        <ErrorAlert error={client.error} title="Couldn't load the OAuth client" />
      ) : (
        <Guide>
          <GuideStep title="Create a Web application client">
            <p>
              Application type: <strong className="text-foreground">Web application</strong>. Name: anything, e.g. agentinbox. Leave “Authorized
              JavaScript origins” empty.
            </p>
            <CloudLink href={cloudUrl.createClient(project)} disabled={!project}>
              Create OAuth client
            </CloudLink>
          </GuideStep>
          <GuideStep title="Add this exact Authorized redirect URI">
            <p>Under “Authorized redirect URIs”, click Add URI and paste:</p>
            <CopyField value={v!.redirectUri} size="lg" />
            {v!.callbackMode === "paste" && (
              <Alert variant="info" className="text-foreground">
                <InfoIcon />
                <AlertTitle>Why localhost?</AlertTitle>
                <AlertDescription>
                  Your public URL is plain http, and Google only accepts https or localhost redirects. After signing in, your browser will try to
                  open this address; you'll paste it back into agentinbox. That's all paste mode means.
                </AlertDescription>
              </Alert>
            )}
            <p>Then click Create.</p>
          </GuideStep>
          <GuideStep title="Paste the client ID and secret" done={configured}>
            <p>Google shows both right after you click Create. Copy the secret now: newer clients only show it once (you can add a new one later).</p>
            {configured && (
              <p className="flex items-center gap-1.5 text-foreground">
                <CheckCircle2Icon className="size-4 text-success" /> Saved. Paste new values below only if you want to replace them.
              </p>
            )}
            <div className="max-w-xl pt-1">
              <ClientForm
                view={v}
                projectId={project || undefined}
                appType={appType}
                submitLabel={configured ? "Update client" : "Save client"}
                onSaved={() => !configured && onNext()}
              />
            </div>
          </GuideStep>
        </Guide>
      )}
    </StepCard>
  );
}
