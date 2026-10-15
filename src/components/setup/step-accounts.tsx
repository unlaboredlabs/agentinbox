import { useQuery } from "@tanstack/react-query";
import { MailPlusIcon } from "lucide-react";
import { AccountsList } from "@/components/accounts/accounts-list";
import { connectAccount } from "@/components/accounts/connect-host";
import { GoogleErrorHelp } from "@/components/accounts/google-error-help";
import { RedirectNotice } from "@/components/google/redirect-notice";
import { Button } from "@/components/ui/button";
import { queries } from "@/lib/queries";
import { STEP_META } from "./progress";
import { SetupWarnings } from "./setup-warnings";
import type { StepProps } from "./step-url";
import { Path, StepCard, StepFooter } from "./wizard-shell";

const ACCOUNT_WARNINGS = new Set(["testing_mode", "sign_in_expires", "needs_reauth", "app_type_mismatch"]);

export function StepAccounts({ index, onBack, onNext }: StepProps) {
  const accounts = useQuery(queries.accounts());
  const client = useQuery(queries.googleClient());
  const count = accounts.data?.length ?? 0;
  const paste = client.data?.callbackMode === "paste";
  const internal = client.data?.appType === "internal";

  return (
    <StepCard
      index={index}
      title={STEP_META.accounts.title}
      description="Sign in with Google for each mailbox your agents should work with. agentinbox keeps the sign-in; agents never see it."
      footer={
        <StepFooter
          onBack={onBack}
          onNext={onNext}
          nextDisabled={count === 0}
          nextVariant={count === 0 ? "outline" : "default"}
          hint={count === 0 ? "Connect at least one account" : undefined}
          extra={
            count > 0 && (
              <Button variant="outline" onClick={() => connectAccount()}>
                <MailPlusIcon /> Connect another
              </Button>
            )
          }
        />
      }
    >
      <RedirectNotice />
      <SetupWarnings filter={(w) => ACCOUNT_WARNINGS.has(w.code)} />
      {count === 0 && (
        <div className="space-y-4 rounded-lg border border-dashed p-4">
          <div className="space-y-2 text-sm">
            <p className="font-medium">A Google window opens. What you'll see there:</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                Choose the account{internal ? " (only accounts in your Google Workspace organization can connect)" : ""}. Shared addresses like
                groups or aliases can't sign in.
              </li>
              {!internal && (
                <li>
                  “Google hasn't verified this app”: expected for your own app. Click <Path items={["Advanced", "Go to agentinbox (unsafe)"]} />.
                </li>
              )}
              <li>
                Tick the Gmail box (or <strong className="text-foreground">Select all</strong>), then <strong className="text-foreground">Continue</strong>.
              </li>
              <li>
                {paste
                  ? "The window lands on a localhost page that may not load: copy its address and paste it into agentinbox (the dialog walks you through it)."
                  : "The window closes and the account shows up here as Active."}
              </li>
            </ol>
          </div>
          <Button onClick={() => connectAccount()}>
            <MailPlusIcon /> Connect a Gmail account
          </Button>
        </div>
      )}
      {count > 0 && <AccountsList />}
      <GoogleErrorHelp />
    </StepCard>
  );
}
