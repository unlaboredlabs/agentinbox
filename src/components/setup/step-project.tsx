import { useState } from "react";
import { projectIdError } from "@/components/google/client-form";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PROJECT_ID_RE, updateDraft, useSetupProgress } from "./progress";
import type { StepProps } from "./step-url";
import { CloudLink, Guide, GuideStep, StepCard, StepFooter } from "./wizard-shell";

export const cloudUrl = {
  createProject: "https://console.cloud.google.com/projectcreate",
  gmailApi: (p: string) => `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=${encodeURIComponent(p)}`,
  pubsubApi: (p: string) => `https://console.cloud.google.com/apis/library/pubsub.googleapis.com?project=${encodeURIComponent(p)}`,
  authOverview: (p: string) => `https://console.cloud.google.com/auth/overview?project=${encodeURIComponent(p)}`,
  authAudience: (p: string) => `https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(p)}`,
  authScopes: (p: string) => `https://console.cloud.google.com/auth/scopes?project=${encodeURIComponent(p)}`,
  createClient: (p: string) => `https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(p)}`,
};

export function StepProject({ index, onBack, onNext }: StepProps) {
  const { state, draft } = useSetupProgress();
  const [projectId, setProjectId] = useState(draft.projectId ?? state?.gcpProjectId ?? "");
  const [touched, setTouched] = useState(false);
  const clean = projectId.trim();
  const error = projectIdError(clean);
  const valid = PROJECT_ID_RE.test(clean);

  const next = () => {
    setTouched(true);
    if (!valid) return;
    updateDraft({ projectId: clean, projectConfirmed: true });
    onNext();
  };

  return (
    <StepCard
      index={index}
      title="Create a Google Cloud project"
      description="agentinbox uses your own Google Cloud project and OAuth app, so your mail never passes through anyone else's. It's free and takes a couple of minutes."
      footer={<StepFooter onBack={onBack} onNext={next} nextDisabled={touched && !valid} />}
    >
      <Guide>
        <GuideStep title="Create a project (or pick an existing one)">
          <p>Any name works, e.g. “agentinbox”. With Google Workspace, create it inside your organization.</p>
          <CloudLink href={cloudUrl.createProject}>Create project</CloudLink>
        </GuideStep>
        <GuideStep title="Paste the project ID" done={valid}>
          <p>
            Find it on the project's dashboard or in the project picker at the top of Google Cloud. It's the lowercase ID (like{" "}
            <code className="font-mono text-foreground">agentinbox-471203</code>), not the display name or the project number.
          </p>
          <Field data-invalid={touched && !!error} className="max-w-sm">
            <FieldLabel htmlFor="gcp-project" className="sr-only">
              Project ID
            </FieldLabel>
            <Input
              id="gcp-project"
              className="font-mono"
              placeholder="agentinbox-471203"
              spellCheck={false}
              autoComplete="off"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value.toLowerCase())}
              onBlur={() => clean && setTouched(true)}
              onKeyDown={(e) => e.key === "Enter" && next()}
              aria-invalid={touched && !!error}
            />
            {touched && error ? <FieldError>{error}</FieldError> : <FieldDescription>The links below open in this project.</FieldDescription>}
          </Field>
        </GuideStep>
        <GuideStep title="Enable the Gmail API">
          <p>Open the API page and click Enable.</p>
          <CloudLink href={valid ? cloudUrl.gmailApi(clean) : "#"} disabled={!valid}>
            Enable Gmail API
          </CloudLink>
        </GuideStep>
        <GuideStep title="Enable the Cloud Pub/Sub API (recommended)">
          <p>Only needed for real-time delivery (step 6), but enabling it now saves a trip back.</p>
          <CloudLink href={valid ? cloudUrl.pubsubApi(clean) : "#"} disabled={!valid}>
            Enable Pub/Sub API
          </CloudLink>
        </GuideStep>
      </Guide>
    </StepCard>
  );
}
