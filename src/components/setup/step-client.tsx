import type { GoogleClientCheck } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/common";
import { ClientForm, secretHintOf } from "@/components/google/client-form";
import { ClientCheckResult } from "@/components/google/client-check";
import { ClientImport } from "@/components/google/client-import";
import { RedirectNotice } from "@/components/google/redirect-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";
import { STEP_META, useSetupProgress } from "./progress";
import { SetupWarnings } from "./setup-warnings";
import { cloudUrl } from "./step-project";
import type { StepProps } from "./step-url";
import { CloudLink, Disclosure, FormValues, GoogleTabNote, Guide, GuideStep, StepCard, StepFooter } from "./wizard-shell";

export function StepClient({ index, onBack, onNext }: StepProps) {
  const { state, draft } = useSetupProgress();
  const client = useQuery(queries.googleClient());
  // Server values win; the draft only fills in what the server doesn't have yet.
  const project = state?.gcpProjectId ?? client.data?.projectId ?? draft.projectId ?? "";
  const appType = state?.googleAppType ?? client.data?.appType ?? draft.appType ?? undefined;
  const configured = !!client.data?.clientId && !!client.data.hasSecret;
  const [manual, setManual] = useState(false);
  // What Google said about the client right after it was saved (import or manual), and on "Check again".
  const [check, setCheck] = useState<GoogleClientCheck>();
  const reusing = draft.projectMode === "existing";
  const v = client.data;

  return (
    <StepCard
      index={index}
      title={STEP_META.client.title}
      description="The OAuth client is agentinbox's ID card at Google: it's what you sign in through when you connect Gmail."
      footer={<StepFooter onBack={onBack} onNext={onNext} nextDisabled={!configured} hint={!configured ? "Import the client JSON first" : undefined} />}
    >
      {client.isPending ? (
        <Skeleton className="h-64" />
      ) : client.isError ? (
        <ErrorAlert error={client.error} title="Couldn't load the OAuth client" />
      ) : (
        <>
          <GoogleTabNote />
          {reusing && (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>Create a new client, even if the project has one</AlertTitle>
              <AlertDescription>
                Don't reuse the other app's client ID or secret: rotating or deleting it would break both apps, and Google limits how many sign-ins
                each client keeps per account.
              </AlertDescription>
            </Alert>
          )}
          <RedirectNotice />
          <Guide>
            <GuideStep
              title="Open the Create OAuth client form and fill it in"
              expect={
                <>
                  a dialog “<strong className="text-foreground">OAuth client created</strong>” with the client ID and secret.
                </>
              }
            >
              <CloudLink href={cloudUrl.createClient(project)} disabled={!project} disabledReason="Enter the project ID in step 2 first">
                Open Create OAuth client
              </CloudLink>
              <FormValues
                rows={[
                  { label: "Application type", note: <strong className="text-foreground">Web application</strong> },
                  { label: "Name", value: "agentinbox", copyLabel: "Copy client name" },
                  { label: "Authorized JavaScript origins", note: "Leave empty." },
                  {
                    label: "Authorized redirect URIs",
                    value: v!.redirectUri,
                    copyLabel: "Copy redirect URI",
                    note: "Click Add URI and paste exactly this (no trailing slash).",
                  },
                  {
                    label: "“Use this client for an AI-powered agent”",
                    note: "Leave it unticked: agentinbox calls Gmail itself.",
                  },
                ]}
              />
              {v!.callbackMode === "paste" && (
                <p className="flex items-start gap-1.5 text-xs">
                  <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                  <span>
                    Why localhost? Your address is plain http, and Google only returns to https or localhost. After you sign in, the browser lands
                    on this localhost address and you paste it back into agentinbox.
                  </span>
                </p>
              )}
              <p>
                Then click <strong className="text-foreground">Create</strong>.
              </p>
            </GuideStep>
            <GuideStep title="Click Download JSON in that dialog">
              <p>
                Google shows the secret only in this dialog, so download it before you close it. The file is called{" "}
                <span className="font-mono text-xs text-foreground">client_secret_….json</span> (in your Downloads folder).
              </p>
            </GuideStep>
            <GuideStep title="Give agentinbox the JSON file" done={configured}>
              {configured && (
                <p className="flex items-start gap-1.5 text-foreground">
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
                  <span>
                    Saved: client <span className="font-mono text-xs break-all">{v!.clientId}</span>
                    {secretHintOf(v) ? ` (secret ending in …${secretHintOf(v)})` : ""}. Import another file only to replace it.
                  </span>
                </p>
              )}
              <ClientImport
                appType={appType}
                expectedProjectId={project || undefined}
                onNeedsManual={() => setManual(true)}
                onImported={(r) => setCheck(r.check)}
                quiet
              />
              {configured && <ClientCheckResult check={check} view={v} onChecked={setCheck} />}
              {!check && <SetupWarnings filter={(w) => w.code === "client_invalid" || w.code === "client_secret_invalid"} />}
              <Disclosure
                key={manual ? "open" : "closed"}
                defaultOpen={manual}
                summary="Closed the dialog without downloading? Enter the client ID and secret by hand"
              >
                <p>
                  Open <strong className="text-foreground">Google Auth Platform → Clients</strong> → your client. The client ID is on that page. The
                  secret isn't shown again: click <strong className="text-foreground">Add secret</strong>, copy the new one, and paste both here.
                </p>
                <CloudLink href={cloudUrl.clients(project)} disabled={!project}>
                  Open Clients
                </CloudLink>
                <div className="max-w-xl pt-1 text-foreground">
                  <ClientForm
                    view={v}
                    projectId={project || undefined}
                    appType={appType}
                    submitLabel={configured ? "Replace client" : "Save client"}
                    onSaved={(r) => setCheck(r.check)}
                  />
                </div>
              </Disclosure>
            </GuideStep>
          </Guide>
        </>
      )}
    </StepCard>
  );
}
