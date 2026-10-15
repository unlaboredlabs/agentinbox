import type { SendMode } from "@shared/types";
import { FileTextIcon, SendIcon, StampIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SEND_MODE_INFO } from "@/lib/labels";

// Safest first.
const ORDER: SendMode[] = ["draft_only", "approval", "direct"];
const ICONS = { direct: SendIcon, draft_only: FileTextIcon, approval: StampIcon } as const;

/** Segmented control for how send/reply/forward behave, with the selected mode explained below it. */
export function SendModeControl({ value, onChange, disabled }: { value: SendMode; onChange: (v: SendMode) => void; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value}
        disabled={disabled}
        onValueChange={(v) => v && onChange(v as SendMode)}
        aria-label="Send mode"
        className="flex-wrap"
      >
        {ORDER.map((m) => {
          const Icon = ICONS[m];
          return (
            <ToggleGroupItem key={m} value={m}>
              <Icon /> {SEND_MODE_INFO[m].label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">{SEND_MODE_INFO[value].description}</p>
    </div>
  );
}
