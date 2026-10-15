import type { GoogleAppType } from "@shared/types";
import { AlertTriangleIcon, BuildingIcon, GlobeIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { ChoiceCards } from "@/components/choice-cards";
import { CopyField } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { updateDraft, useSetupProgress } from "./progress";
import { cloudUrl } from "./step-project";
import type { StepProps } from "./step-url";
import { CloudLink, Guide, GuideStep, StepCard, StepFooter } from "./wizard-shell";

export const SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  pubsub: "https://www.googleapis.com/auth/pubsub",
};

export function StepConsent({ index, onBack, onNext }: StepProps) {
  const { state, draft } = useSetupProgress();
  const project = draft.projectId ?? state?.gcpProjectId ?? "";
  const [appType, setAppType] = useState<GoogleAppType | undefined>(draft.appType ?? state?.googleAppType ?? undefined);
  const [production, setProduction] = useState(!!draft.productionConfirmed || state?.googleAppType === "external");
  const blocked = !appType || (appType === "external" && !production);

  const next = () => {
    if (blocked) return;
    updateDraft({ appType, productionConfirmed: appType === "external" ? production : undefined });
    onNext();
  };

  return (
    <StepCard
      index={index}
      title="Configure the OAuth consent screen"
      description="This is the screen you'll see when connecting Gmail. Only you (and anyone you connect) will ever see it."
      footer={
        <StepFooter
          onBack={onBack}
          onNext={next}
          nextDisabled={blocked}
          hint={!appType ? "Choose an audience" : appType === "external" && !production ? "Confirm the app is In production" : undefined}
        />
      }
    >
      <Guide>
        <GuideStep title="Open Google Auth Platform and click Get started">
          <p>
            App name: <strong className="text-foreground">agentinbox</strong>. Support and contact email: your own. If the project already has a
            consent screen, open its Branding page instead.
          </p>
          <CloudLink href={cloudUrl.authOverview(project)} disabled={!project}>
            Open Google Auth Platform
          </CloudLink>
        </GuideStep>
        <GuideStep title="Choose the audience" done={!!appType}>
          <p>Pick the same option here as in Google Cloud. It decides who can connect and how long access lasts.</p>
          <ChoiceCards
            aria-label="Audience"
            value={appType}
            onChange={setAppType}
            columns={2}
            choices={[
              {
                value: "internal",
                icon: BuildingIcon,
                title: "Internal",
                badge: <Badge variant="secondary">Workspace</Badge>,
                description:
                  "Only accounts in your Google Workspace organization. No verification, no test users, and access never expires on its own. Not available for personal @gmail.com projects.",
              },
              {
                value: "external",
                icon: GlobeIcon,
                title: "External",
                badge: <Badge variant="secondary">@gmail.com</Badge>,
                description:
                  "Any Google account, including personal @gmail.com and other organizations. Must be published to In production (next step) or access dies after 7 days.",
              },
            ]}
          />
        </GuideStep>
        {appType === "external" && (
          <GuideStep title="Publish the app: set it to In production" done={production}>
            <Alert variant="warning" className="text-foreground">
              <AlertTriangleIcon />
              <AlertTitle>Don't skip this. Apps left in Testing break after 7 days.</AlertTitle>
              <AlertDescription>
                <p>
                  While the publishing status is <strong>Testing</strong>, Google expires refresh tokens after 7 days and every connected account
                  silently disconnects. Adding yourself as a test user does <strong>not</strong> fix this.
                </p>
                <p>
                  Go to <strong>Audience</strong>, click <strong>Publish app</strong> and confirm. You don't need to submit for verification to use
                  it with your own accounts.
                </p>
              </AlertDescription>
            </Alert>
            <CloudLink href={cloudUrl.authAudience(project)} disabled={!project}>
              Open Audience
            </CloudLink>
            <div className="flex items-start gap-2 pt-1">
              <Checkbox id="in-production" checked={production} onCheckedChange={(v) => setProduction(v === true)} className="mt-0.5" />
              <Label htmlFor="in-production" className="text-sm leading-snug font-normal text-foreground">
                The publishing status says <strong>In production</strong>
              </Label>
            </div>
            <p className="flex items-start gap-1.5 text-xs">
              <ShieldCheckIcon className="mt-px size-3.5 shrink-0" />
              When you connect an account you'll see “Google hasn't verified this app”. That's expected for your own app and safe to click through
              (Advanced → Go to agentinbox).
            </p>
          </GuideStep>
        )}
        <GuideStep title="Add the scopes agentinbox needs">
          <p>
            Open <strong>Data access</strong>, click <strong>Add or remove scopes</strong>, paste these under “Manually add scopes”, then Update and
            Save.
          </p>
          <div className="space-y-1.5">
            <CopyField value={SCOPES.gmail} />
            <p className="text-xs">Read, draft, send and label mail. Agents only get what their grants allow.</p>
            <CopyField value={SCOPES.pubsub} />
            <p className="text-xs">Lets agentinbox set up real-time delivery for you (step 6). Skip it if you'll use polling.</p>
          </div>
          <CloudLink href={cloudUrl.authScopes(project)} disabled={!project}>
            Open Data access
          </CloudLink>
        </GuideStep>
      </Guide>
    </StepCard>
  );
}
