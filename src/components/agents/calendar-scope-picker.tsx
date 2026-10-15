import type { CalendarInfo } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ErrorAlert } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ApiError } from "@/lib/api";
import { queries } from "@/lib/queries";

/** Why an account's calendar list can't be shown, in words with the fix (GET /accounts/:id/calendars 409s), or null. */
export function calendarListProblem(err: unknown): React.ReactNode {
  if (!(err instanceof ApiError)) return null;
  const accounts = (
    <Link to="/accounts" className="font-medium text-foreground underline underline-offset-4">
      Accounts
    </Link>
  );
  if (err.code === "calendar_not_granted") return <>This account hasn't added Google Calendar yet. Add it on {accounts}, then pick calendars here.</>;
  if (err.code === "calendar_api_disabled") return <>The Google Calendar API is turned off in your Cloud project. Turn it on from {accounts}.</>;
  if (err.code === "needs_reauth") return <>Google no longer accepts this account's sign-in. Reconnect it on {accounts}.</>;
  return null;
}

/** Checkboxes over calendars, primary first. Ids in `value` that aren't listed (removed since) stay visible so they can be unticked. */
export function CalendarChecklist({ calendars, value, onChange }: { calendars: CalendarInfo[]; value: string[]; onChange: (v: string[]) => void }) {
  const listed = new Set(calendars.map((c) => c.id));
  const missing = value.filter((id) => !listed.has(id));
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...value, id])] : value.filter((x) => x !== id));
  const sorted = [...calendars].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {sorted.map((c) => (
        <label
          key={c.id}
          className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 has-[[data-state=checked]]:bg-muted/40"
        >
          <Checkbox checked={value.includes(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} />
          <span className="size-2.5 shrink-0 rounded-full border" style={c.color ? { backgroundColor: c.color, borderColor: c.color } : undefined} aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={c.id}>
            {c.name}
          </span>
          {c.primary ? (
            <Badge variant="secondary" className="font-normal">
              Primary
            </Badge>
          ) : (
            (c.accessRole === "reader" || c.accessRole === "freeBusyReader") && (
              <span className="shrink-0 text-xs text-muted-foreground">read-only</span>
            )
          )}
        </label>
      ))}
      {missing.map((id) => (
        <label key={id} className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-dashed px-3 py-2 text-sm">
          <Checkbox checked onCheckedChange={(v) => toggle(id, v === true)} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={id}>
            {id}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">no longer listed</span>
        </label>
      ))}
    </div>
  );
}

/** A grant's calendar scope: every calendar in the account's list (null) or only the chosen ones. */
export function CalendarScopePicker({
  accountId,
  value,
  onChange,
  disabled,
}: {
  accountId: string;
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  disabled?: boolean;
}) {
  // Only fetched once "Only some" is chosen: the list is live from Google.
  const calendars = useQuery({ ...queries.accountCalendars(accountId), enabled: value !== null && !disabled });
  return (
    <div className="space-y-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value === null ? "all" : "some"}
        disabled={disabled}
        onValueChange={(v) => v && onChange(v === "all" ? null : (value ?? []))}
        aria-label="Calendar scope"
      >
        <ToggleGroupItem value="all">Every calendar</ToggleGroupItem>
        <ToggleGroupItem value="some">Only some calendars</ToggleGroupItem>
      </ToggleGroup>
      {value === null ? (
        <p className="text-xs text-muted-foreground">Every calendar in the account's list, including ones added later.</p>
      ) : calendars.isPending ? (
        <div className="grid gap-1.5 sm:grid-cols-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : calendars.isError ? (
        calendarListProblem(calendars.error) ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">{calendarListProblem(calendars.error)}</p>
        ) : (
          <ErrorAlert error={calendars.error} title="Couldn't load the account's calendars" />
        )
      ) : (
        <>
          <CalendarChecklist calendars={calendars.data} value={value} onChange={onChange} />
          {value.length === 0 && <p className="text-xs text-warning">Pick at least one calendar, or the agent can't use any.</p>}
        </>
      )}
    </div>
  );
}
