import { BanIcon, CalendarCheckIcon, StampIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { CalendarWriteChoice } from "@/lib/grants";
import { CALENDAR_NO_WRITE_INFO, CALENDAR_WRITE_MODE_INFO } from "@/lib/labels";

// Safest first.
const ORDER: CalendarWriteChoice[] = ["none", "approval", "direct"];
const ICONS = { none: BanIcon, approval: StampIcon, direct: CalendarCheckIcon } as const;
const info = (c: CalendarWriteChoice) => (c === "none" ? CALENDAR_NO_WRITE_INFO : CALENDAR_WRITE_MODE_INFO[c]);

/** Segmented control for calendar writes: none (no calendar.write), ask first (approval) or direct, explained below it. */
export function CalendarWriteControl({ value, onChange }: { value: CalendarWriteChoice; onChange: (v: CalendarWriteChoice) => void }) {
  return (
    <div className="space-y-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value}
        onValueChange={(v) => v && onChange(v as CalendarWriteChoice)}
        aria-label="Calendar writes"
        className="flex-wrap"
      >
        {ORDER.map((c) => {
          const Icon = ICONS[c];
          return (
            <ToggleGroupItem key={c} value={c}>
              <Icon /> {info(c).label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">{info(value).description}</p>
    </div>
  );
}
