import { StatusDot } from "@/components/common";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStreamState } from "@/lib/stream";

const STATES = {
  open: { tone: "good", label: "Live", tip: "Receiving live updates from the server." },
  connecting: { tone: "idle", label: "Connecting", tip: "Opening the live update stream…" },
  reconnecting: { tone: "warn", label: "Reconnecting", tip: "The live stream dropped. Retrying; pages refresh once it's back." },
  offline: { tone: "bad", label: "Offline", tip: "Can't reach the server for live updates. Retrying in the background." },
} as const;

/** Subtle live-stream status for the top bar. */
export function ConnectionIndicator() {
  const state = useStreamState();
  const s = STATES[state];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <StatusDot tone={s.tone} pulse={state === "reconnecting"} />
          <span className="hidden sm:inline">{s.label}</span>
          <span className="sr-only sm:hidden">{s.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{s.tip}</TooltipContent>
    </Tooltip>
  );
}
