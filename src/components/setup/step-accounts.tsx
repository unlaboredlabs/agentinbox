import { useQuery } from "@tanstack/react-query";
import { MailPlusIcon } from "lucide-react";
import { AccountsList } from "@/components/accounts/accounts-list";
import { connectAccount } from "@/components/accounts/connect-host";
import { UnverifiedTip } from "@/components/accounts/unverified-tip";
import { Button } from "@/components/ui/button";
import { queries } from "@/lib/queries";
import type { StepProps } from "./step-url";
import { StepCard, StepFooter } from "./wizard-shell";

export function StepAccounts({ index, onBack, onNext }: StepProps) {
  const accounts = useQuery(queries.accounts());
  const client = useQuery(queries.googleClient());
  const count = accounts.data?.length ?? 0;
  const paste = client.data?.callbackMode === "paste";

  return (
    <StepCard
      index={index}
      title="Connect Gmail accounts"
      description="Sign in with Google for each mailbox agents should work with. agentinbox keeps the credentials; agents never see them."
      footer={
        <StepFooter
          onBack={onBack}
          onNext={onNext}
          nextDisabled={count === 0}
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
      {count === 0 && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
          <p className="text-sm">
            A Google sign-in window opens. Choose the account, allow access, and you're back here.
            {paste && " Because your public URL is plain http, you'll paste the final address back into agentinbox (we'll walk you through it)."}
          </p>
          <Button onClick={() => connectAccount()}>
            <MailPlusIcon /> Connect a Gmail account
          </Button>
        </div>
      )}
      {count > 0 && <AccountsList />}
      <UnverifiedTip />
    </StepCard>
  );
}
