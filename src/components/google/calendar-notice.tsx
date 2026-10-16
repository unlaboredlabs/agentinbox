import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, AlertTriangleIcon, CalendarPlusIcon, InfoIcon } from "lucide-react";
import type { CalendarSetupState } from "@shared/types";
import { ExternalLink, linkify } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { calendarNotice } from "./calendar-flow";
import { openCalendarSetup } from "./calendar-setup";

const ICON = { error: AlertCircleIcon, warning: AlertTriangleIcon, info: InfoIcon };
const VARIANT = { error: "destructive", warning: "warning", info: "info" } as const;

/** The Calendar notice on Overview and Accounts: "Add Google Calendar" on upgraded installs, then what's left to fix. */
export function CalendarNotice({ className }: { className?: string }) {
  const qc = useQueryClient();
  const state = useQuery(queries.setupState());
  const dismiss = useApiMutation({
    mutationFn: () => api<CalendarSetupState>("/api/google/calendar", { method: "PATCH", body: { dismissed: true } }),
    invalidate: [keys.setupState],
    success: "Hidden. Add Google Calendar any time from Settings or Accounts.",
    errorTitle: "Couldn't hide the notice",
    onSuccess: (s) => qc.setQueryData(keys.calendarSetup, s),
  });
  const n = calendarNotice(state.data?.warnings ?? []);
  if (!n) return null;
  const Icon = n.code === "calendar_not_added" ? CalendarPlusIcon : ICON[n.severity];
  return (
    <Alert variant={VARIANT[n.severity]} className={className}>
      <Icon />
      <AlertTitle>{n.title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{linkify(n.body)}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {n.action && (
            <Button size="sm" variant={n.severity === "info" ? "default" : "outline"} onClick={() => openCalendarSetup(n.action?.page)}>
              {n.action.label}
            </Button>
          )}
          {n.url && <ExternalLink href={n.url}>Open in Google Cloud</ExternalLink>}
          {n.dismissible && (
            <Button size="sm" variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
              Not now
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
