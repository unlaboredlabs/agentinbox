import type { CalendarSetupState } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlusIcon } from "lucide-react";
import { AccountsList } from "@/components/accounts/accounts-list";
import { connectAccount } from "@/components/accounts/connect-host";
import { GoogleErrorHelp } from "@/components/accounts/google-error-help";
import { RedirectNotice } from "@/components/google/redirect-notice";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { STEP_META } from "./progress";
import { SetupWarnings } from "./setup-warnings";
import type { StepProps } from "./step-url";
import { Path, StepCard, StepFooter } from "./wizard-shell";

const ACCOUNT_WARNINGS = new Set([
  "testing_mode",
  "sign_in_expires",
  "needs_reauth",
  "app_type_mismatch",
  "calendar_api_disabled",
  "calendar_scope_missing",
  "calendar_sync_failing",
]);

export function StepAccounts({ index, onBack, onNext }: StepProps) {
  const accounts = useQuery(queries.accounts());
  const client = useQuery(queries.googleClient());
  const count = accounts.data?.length ?? 0;
  const paste = client.data?.callbackMode === "paste";
  const internal = client.data?.appType === "internal";
  const calendar = useQuery({ ...queries.calendarSetup(), retry: false });
  const withCalendar = calendar.data?.enabled ?? false;

  return (
    <StepCard
      index={index}
      title={STEP_META.accounts.title}
      description={
        withCalendar
          ? "Sign in with Google for each mailbox your agents should work with: one sign-in covers its Gmail and Google Calendar. agentinbox keeps the sign-in; agents never see it."
          : "Sign in with Google for each mailbox your agents should work with. agentinbox keeps the sign-in; agents never see it."
      }
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
              {withCalendar ? (
                <li>
                  A list of permissions, each with its own checkbox: Gmail, then three for Google Calendar (events, calendar list, free/busy). Click{" "}
                  <strong className="text-foreground">Select all</strong> (or tick each), then <strong className="text-foreground">Continue</strong>.
                  Gmail is required; if Calendar is unticked, mail still works and you can add Calendar later.
                </li>
              ) : (
                <li>
                  Tick the Gmail box (or <strong className="text-foreground">Select all</strong>), then <strong className="text-foreground">Continue</strong>.
                </li>
              )}
              <li>
                {paste
                  ? "The window lands on a localhost page that may not load: copy its address and paste it into agentinbox (the dialog walks you through it)."
                  : "The window closes and the account shows up here as Active."}
              </li>
            </ol>
          </div>
          <Button onClick={() => connectAccount()}>
            <MailPlusIcon /> Connect a Google account
          </Button>
        </div>
      )}
      {calendar.data && <CalendarChoice setup={calendar.data} />}
      {count > 0 && <AccountsList />}
      <GoogleErrorHelp />
    </StepCard>
  );
}

/**
 * Whether connecting also asks for Google Calendar (CalendarSetupState.enabled, on by default for new
 * installs). Off connects mail only, e.g. when a Workspace admin blocks Calendar for unconfigured apps and
 * Google would refuse the whole sign-in; Calendar can be added later from "Add Google Calendar".
 */
function CalendarChoice({ setup }: { setup: CalendarSetupState }) {
  const qc = useQueryClient();
  const toggle = useApiMutation({
    mutationFn: (enabled: boolean) => api<CalendarSetupState>("/api/google/calendar", { method: "PATCH", body: { enabled } }),
    invalidate: [keys.setupState],
    errorTitle: "Couldn't change the Calendar setting",
    onSuccess: (s) => qc.setQueryData(keys.calendarSetup, s),
  });
  const on = toggle.isPending ? !!toggle.variables : setup.enabled;
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <Switch id="connect-calendar" checked={on} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} className="mt-0.5" />
      <div className="space-y-1">
        <Label htmlFor="connect-calendar">Also add Google Calendar</Label>
        <p className="text-xs text-muted-foreground">
          {on
            ? "Connecting asks for Gmail and Calendar in one sign-in. Agents get Calendar only once you add it to their access."
            : "Off: connecting asks for Gmail only. Add Google Calendar later from Settings or Accounts; mail is never interrupted."}{" "}
          Turn it off if your Google Workspace admin blocks Calendar for this app.
        </p>
      </div>
    </div>
  );
}
