import { CopyButton } from "@/components/common";
import { cn } from "@/lib/utils";

/**
 * A shell command to paste into a terminal, with a copy button that says what it copies.
 * Long commands wrap at spaces (never mid-flag unless a single word can't fit the line).
 */
export function Command({ code, label, className }: { code: string; /** What is copied, e.g. "connect command". */ label: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-1 rounded-lg border bg-muted/40 py-1 pr-1 pl-3", className)}>
      <pre className="min-w-0 flex-1 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">{code}</pre>
      <CopyButton value={code} label={`Copy ${label}`} />
    </div>
  );
}
