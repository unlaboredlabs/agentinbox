import { ArrowRightIcon, CalendarClockIcon, MailIcon, UsersIcon } from "lucide-react";
import { SectionLabel } from "@/components/common";
import { Visible } from "@/components/hidden-chars";
import { cn } from "@/lib/utils";
import { BodyPreview } from "./approval-parts";
import { type CalendarApproval, calendarApprovalView } from "./calendar-approval";

/**
 * What a calendar approval applies: the effects in words, the event before and after, the agent's full
 * description, every guest and every address Google will email. All free text is shown as plain text.
 */
export function CalendarApprovalBody({ approval: a }: { approval: CalendarApproval }) {
  const v = calendarApprovalView(a);
  const showBefore = a.kind !== "calendar.create";
  return (
    <div className="space-y-4">
      <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
        <SectionLabel className="flex items-center gap-1.5">
          <CalendarClockIcon className="size-3.5" /> What applying does
        </SectionLabel>
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {v.effects.map((e) => (
            <li key={e} className="break-words">
              <Visible text={e} />
            </li>
          ))}
        </ul>
      </div>

      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        {v.rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className={cn("min-w-0 break-words", !r.changed && "text-muted-foreground")}>
              {showBefore && r.changed && r.before !== r.after ? (
                <span className="flex flex-wrap items-center gap-x-1.5">
                  {r.before !== null ? (
                    <del className="text-muted-foreground">
                      <Visible text={r.before} />
                    </del>
                  ) : (
                    <span className="text-muted-foreground italic">none</span>
                  )}
                  <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="becomes" />
                  {r.after !== null ? (
                    <span className="font-medium">
                      <Visible text={r.after} />
                    </span>
                  ) : (
                    <span className="font-medium italic">{a.kind === "calendar.delete" ? "deleted" : "none"}</span>
                  )}
                </span>
              ) : (
                <Visible text={r.after ?? r.before ?? "—"} />
              )}
            </dd>
          </div>
        ))}
      </dl>

      {v.description !== null && (
        <div className="space-y-1.5">
          <SectionLabel>{a.kind === "calendar.update" ? "New description" : "Description"}</SectionLabel>
          <BodyPreview body={v.description} />
        </div>
      )}
      {v.comment && (
        <div className="space-y-1.5">
          <SectionLabel>Comment to the organizer</SectionLabel>
          <BodyPreview body={v.comment} />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <People
          icon={MailIcon}
          title={`Emailed by Google (${v.emailed.length})`}
          items={v.emailed}
          empty={a.calendar.notifyAttendees ? "Nobody" : "Nobody: notifications are off"}
        />
        {a.kind !== "calendar.rsvp" && (
          <People
            icon={UsersIcon}
            title={`${a.kind === "calendar.delete" ? "Guests" : "Guests who see the event"} (${v.guests.length + v.moreGuests})`}
            items={v.guests}
            more={v.moreGuests}
            empty="No guests"
          />
        )}
      </div>
    </div>
  );
}

function People({ icon: Icon, title, items, more = 0, empty }: { icon: typeof MailIcon; title: string; items: string[]; more?: number; empty: string }) {
  return (
    <div className="space-y-1.5 rounded-lg border p-3">
      <SectionLabel className="flex items-center gap-1.5">
        <Icon className="size-3.5" /> {title}
      </SectionLabel>
      {items.length ? (
        <ul className="space-y-0.5 text-sm">
          {items.map((x) => (
            <li key={x} className="break-all">
              <Visible text={x} />
            </li>
          ))}
          {more > 0 && <li className="text-muted-foreground">and {more} more Google didn't list</li>}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
