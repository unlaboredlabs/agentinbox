import type { Account } from "@shared/types";
import { ToneBadge } from "@/components/common";
import type { AccountCalendarView } from "@/components/google/calendar-flow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACCOUNT_STATUS } from "@/lib/labels";

export function AccountStatusBadge({ status }: { status: Account["status"] }) {
  const s = ACCOUNT_STATUS[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-4xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ToneBadge tone={s.tone}>{s.label}</ToneBadge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{s.description}</TooltipContent>
    </Tooltip>
  );
}

/** The account's Google Calendar state next to its status: "Mail only" until Calendar is added to it. */
export function CalendarBadge({ view }: { view: AccountCalendarView }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-4xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{view.description}</TooltipContent>
    </Tooltip>
  );
}

/** Letter avatar for a mailbox. */
export function AccountAvatar({ email, className }: { email: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium uppercase ${className ?? ""}`}
    >
      {email.slice(0, 1)}
    </span>
  );
}
