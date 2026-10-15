import { CopyButton } from "@/components/common";
import { cn } from "@/lib/utils";

/**
 * A shell command to paste into a terminal, with a copy button that says what it copies.
 * Wraps only at spaces (never inside a flag like --setup-mcp); a single word longer than the line
 * scrolls sideways instead of breaking.
 */
export function Command({ code, label, className }: { code: string; /** What is copied, e.g. "connect command". */ label: string; className?: string }) {
  const parts = code.split(/(\s+)/);
  return (
    <div className={cn("flex min-w-0 items-start gap-1 rounded-lg border bg-muted/40 py-1 pr-1 pl-3", className)}>
      <pre className="min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
        {parts.map((p, i) => (/^\s+$/.test(p) ? p : <span key={i} className="whitespace-nowrap">{p}</span>))}
      </pre>
      <CopyButton value={code} label={`Copy ${label}`} />
    </div>
  );
}
