import type { CalendarSetupState, GoogleAppType, GoogleClientView, SetupWarning } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, AlertTriangleIcon, CalendarPlusIcon, InfoIcon, RotateCwIcon } from "lucide-react";
import { connectAccount } from "@/components/accounts/connect-host";
import { addCalendarTo, openCalendarSetup } from "@/components/google/calendar-setup";
import { ExternalLink } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { updateDraft } from "./progress";

const ICON = { error: AlertCircleIcon, warning: AlertTriangleIcon, info: InfoIcon };
const VARIANT = { error: "destructive", warning: "warning", info: "info" } as const;

const REAUTH_CAUSES = [
  "the OAuth app was still in Testing (Google ends sign-ins after 7 days)",
  "the account's password changed",
  "access was removed at myaccount.google.com/connections",
  "it wasn't used for 6 months",
  "a Google Workspace session policy ended it",
];

/**
 * SetupState.warnings as alerts with the action that fixes each one (Reconnect, Publish, switch the
 * audience…). `filter` picks the ones relevant where it's shown.
 */
export function SetupWarnings({ filter, className }: { filter?: (w: SetupWarning) => boolean; className?: string }) {
  const state = useQuery(queries.setupState());
  const accounts = useQuery(queries.accounts());
  const client = useQuery(queries.googleClient());
  const setType = useApiMutation({
    mutationFn: ({ v, appType }: { v: GoogleClientView; appType: GoogleAppType }) =>
      api<GoogleClientView>("/api/google/client", { method: "PUT", body: { clientId: v.clientId, projectId: v.projectId ?? "", appType } }),
    invalidate: [keys.googleClient, keys.setupState],
    success: (_d, { appType }) => `Audience set to ${appType === "internal" ? "Internal" : "External"}`,
    errorTitle: "Couldn't change the audience",
    onSuccess: (_d, { appType }) => updateDraft({ appType, productionConfirmed: appType === "external" ? false : undefined }),
  });

  const checkCalendar = useApiMutation({
    mutationFn: () => api<CalendarSetupState>("/api/google/calendar/check", { method: "POST" }),
    invalidate: [keys.setupState, keys.calendarSetup, keys.accounts],
    success: (s) => (s.api === "disabled" ? "Google still says the Calendar API is off" : "The Calendar API is on"),
    errorTitle: "Couldn't check Google Calendar",
  });

  const list = (state.data?.warnings ?? []).filter((w) => !filter || filter(w));
  if (!list.length) return null;

  return (
    <div className={className ? `space-y-3 ${className}` : "space-y-3"}>
      {list.map((w, i) => {
        const Icon = ICON[w.severity];
        const account = w.accountId ? accounts.data?.find((a) => a.id === w.accountId) : undefined;
        const reconnect = account && (w.code === "testing_mode" || w.code === "sign_in_expires" || w.code === "needs_reauth");
        const calendar = calendarAction(w, account, () => checkCalendar.mutate());
        const switchTo: GoogleAppType | null =
          w.code === "app_type_mismatch" && client.data?.clientId ? (client.data.appType === "internal" ? "external" : "internal") : null;
        return (
          <Alert key={`${w.code}-${w.accountId ?? i}`} variant={VARIANT[w.severity]}>
            <Icon />
            <AlertTitle>{w.message}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{w.hint}</p>
              {w.code === "needs_reauth" && (
                <p className="text-xs">Common causes: {REAUTH_CAUSES.join("; ")}.</p>
              )}
              {(w.url || reconnect || switchTo || calendar) && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {w.url && (
                    <ExternalLink href={w.url}>
                      {w.code === "testing_mode" || w.code === "app_type_mismatch"
                        ? "Open Audience in Google Cloud"
                        : w.code === "calendar_api_disabled"
                          ? "Enable the Calendar API"
                          : "Open in Google Cloud"}
                    </ExternalLink>
                  )}
                  {reconnect && (
                    <Button size="sm" variant="outline" onClick={() => connectAccount({ reauthAccountId: account.id, email: account.email })}>
                      <RotateCwIcon /> Reconnect {account.email}
                    </Button>
                  )}
                  {calendar && (
                    <Button size="sm" variant="outline" onClick={calendar.run}>
                      {w.code === "calendar_api_disabled" ? <RotateCwIcon /> : <CalendarPlusIcon />} {calendar.label}
                    </Button>
                  )}
                  {switchTo && w.severity !== "info" && (
                    <Button size="sm" variant="outline" disabled={setType.isPending} onClick={() => setType.mutate({ v: client.data!, appType: switchTo })}>
                      Set the audience to {switchTo === "external" ? "External" : "Internal"} here
                    </Button>
                  )}
                </div>
              )}
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}

/** The "Add Google Calendar" step that fixes a calendar_* warning, if any (sync failures retry by themselves). */
function calendarAction(
  w: SetupWarning,
  account: { id: string; email: string } | undefined,
  check: () => void,
): { label: string; run: () => void } | null {
  switch (w.code) {
    case "calendar_not_added":
      return { label: "Add Google Calendar", run: () => openCalendarSetup() };
    case "calendar_scope_missing":
      return account ? { label: `Add Calendar to ${account.email}`, run: () => addCalendarTo(account) } : null;
    case "calendar_api_disabled":
      return { label: "Check again", run: check };
    default:
      return null;
  }
}
