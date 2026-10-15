import { AlertCircleIcon, CheckIcon, CopyIcon, ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { describeError } from "@/lib/api";
import { fmtAgo, fmtExact } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Browsers only offer the Clipboard API on HTTPS and localhost, and the console is often opened
 * over plain HTTP on a LAN address. There, copy through a selected text field placed next to the
 * button so a dialog's focus trap doesn't steal the selection.
 */
export async function copyText(text: string, near: HTMLElement) {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  near.after(field);
  field.select();
  const ok = document.execCommand("copy");
  field.remove();
  near.focus();
  if (!ok) throw new Error("Copy failed");
}

function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  const onClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      await copyText(value, e.currentTarget);
    } catch {
      toast.error("Couldn't copy", { description: "Select the text and copy it with your keyboard instead." });
      return;
    }
    // The button itself says "Copied" (and a live region announces it): no toast to cover other controls.
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return { copied, onClick };
}

export function CopyButton({
  value,
  label = "Copy",
  className,
  withText,
  variant = "ghost",
}: {
  value: string;
  /** Say what is copied ("Copy redirect URI"): screen readers and the tooltip use it. */
  label?: string;
  className?: string;
  /** Show text next to the icon: true shows the label, a string shows that (the label stays the accessible name). */
  withText?: boolean | string;
  variant?: "ghost" | "outline" | "secondary" | "default";
}) {
  const { copied, onClick } = useCopy(value);
  const live = (
    <span className="sr-only" aria-live="polite">
      {copied ? "Copied" : ""}
    </span>
  );
  if (withText) {
    return (
      <Button type="button" variant={variant} size="sm" className={className} onClick={onClick} aria-label={copied ? undefined : label}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : withText === true ? label : withText}
        {live}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size="icon-sm"
          className={cn("text-muted-foreground", className)}
          aria-label={copied ? "Copied" : label}
          onClick={onClick}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {live}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

// Soft wrap points inside a long token: after URL separators, never after a hyphen
// (so `--set-as-default` or `agentinbox-123456` stay whole) and never between "//".
const SOFT_BREAK = /(?<=[/?&,])(?=[^/])/;

/**
 * Text that wraps at spaces and after / ? & , only. Each piece in between is unbreakable, so long
 * commands and URLs never split mid-flag or mid-word; a piece wider than the box scrolls instead.
 */
export function Wrapped({ text }: { text: string }) {
  return text.split(/(\s+)/).map((tok, i) =>
    !tok || /^\s+$/.test(tok) ? (
      tok
    ) : (
      <span key={i}>
        {tok.split(SOFT_BREAK).map((seg, j) => (
          <Fragment key={j}>
            {j > 0 && <wbr />}
            <span className="whitespace-nowrap">{seg}</span>
          </Fragment>
        ))}
      </span>
    ),
  );
}

/** A value that must be pasted somewhere else: monospace, selectable, with a prominent copy button. */
export function CopyField({
  value,
  className,
  size = "default",
  label = "Copy",
}: {
  value: string;
  className?: string;
  size?: "default" | "lg";
  /** What the copy button copies, e.g. "Copy redirect URI". */
  label?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-lg border bg-muted/40 pl-3 text-foreground",
        size === "lg" ? "py-1.5 pr-1.5" : "py-0.5 pr-0.5",
        className,
      )}
    >
      <code className={cn("min-w-0 flex-1 overflow-x-auto py-1 font-mono whitespace-pre-wrap select-all", size === "lg" ? "text-sm" : "text-[13px]")}>
        <Wrapped text={value} />
      </code>
      <CopyButton value={value} label={label} withText={size === "lg" && "Copy"} variant={size === "lg" ? "outline" : "ghost"} />
    </div>
  );
}

/** A multi-line snippet with a copy button. Plain text only. */
export function CodeBlock({
  code,
  className,
  title,
  wrap,
  copyLabel = "Copy",
}: {
  code: string;
  className?: string;
  title?: React.ReactNode;
  /** Wrap long lines (shell commands) at spaces and separators instead of scrolling. */
  wrap?: boolean;
  /** What the copy button copies, e.g. "Copy command". */
  copyLabel?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-muted/40", className)}>
      {title && (
        <div className="flex items-center justify-between gap-2 border-b bg-muted/40 py-1 pr-1 pl-3 text-xs text-muted-foreground">
          <span className="truncate font-mono">{title}</span>
          <CopyButton value={code} label={copyLabel} />
        </div>
      )}
      <div className="relative">
        <pre className={cn("overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground", !title && "pr-10", wrap && "whitespace-pre-wrap")}>
          {wrap ? <Wrapped text={code} /> : code}
        </pre>
        {!title && <CopyButton value={code} label={copyLabel} className="absolute top-1.5 right-1.5" />}
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  loading,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  loading?: boolean;
  tone?: Tone;
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="space-y-1.5 px-4">
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span className="truncate">{label}</span>
          {Icon && <Icon className={cn("size-4 shrink-0", tone && TONE_TEXT[tone])} />}
        </div>
        {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-2xl font-semibold tracking-tight tabular">{value}</div>}
        {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

const TONE_BG: Record<Tone, string> = {
  good: "bg-success",
  warn: "bg-warning",
  bad: "bg-critical",
  idle: "bg-muted-foreground/50",
  info: "bg-chart-1",
};
const TONE_TEXT: Record<Tone, string> = {
  good: "text-success",
  warn: "text-warning",
  bad: "text-critical",
  idle: "text-muted-foreground",
  info: "text-chart-1",
};

/** Status dot; always pair with a text label (color is never the only signal). */
export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", TONE_BG[tone])} />}
      <span className={cn("relative inline-flex size-2 rounded-full", TONE_BG[tone])} />
    </span>
  );
}

export function ToneBadge({ tone, children, className, pulse }: { tone: Tone; children: React.ReactNode; className?: string; pulse?: boolean }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", className)}>
      <StatusDot tone={tone} pulse={pulse} className="size-1.5 [&>span]:size-1.5" />
      {children}
    </Badge>
  );
}

/** Relative time ("3 minutes ago") that stays current, with the exact timestamp on hover. */
export function TimeAgo({ date, className, fallback = "—" }: { date: string | null | undefined; className?: string; fallback?: string }) {
  useNow(15_000);
  if (!date) return <span className={cn("text-muted-foreground", className)}>{fallback}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={date} className={cn("whitespace-nowrap underline decoration-dotted decoration-muted-foreground/40 underline-offset-4", className)}>
          {fmtAgo(date)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{fmtExact(date)}</TooltipContent>
    </Tooltip>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4 hover:text-chart-1", className)}
    >
      {children}
      <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** Turns the https:// URLs in a server hint into links (they're deep links to the fix). */
export function linkify(text: string): React.ReactNode {
  const parts = text.split(/(https:\/\/[^\s)]+[^\s).,;:])/);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-3">
        {part}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    ) : (
      part
    ),
  );
}

/** Server error, rendered prominently with its remediation hint. */
export function ErrorAlert({
  error,
  title,
  children,
  className,
}: {
  error: unknown;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { message, hint } = describeError(error);
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircleIcon />
      <AlertTitle>{title ?? message}</AlertTitle>
      <AlertDescription>
        {title && <p>{message}</p>}
        {hint && <p className="text-foreground/80">{linkify(hint)}</p>}
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** Full-width error state for a failed page query, with retry. */
export function QueryError({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <ErrorAlert error={error} title="Couldn't load this" className={className}>
      {onRetry && (
        <div className="pt-2">
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCwIcon /> Try again
          </Button>
        </div>
      )}
    </ErrorAlert>
  );
}

/** Small uppercase heading for groups inside cards. */
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("text-xs font-medium tracking-wide text-muted-foreground uppercase", className)}>{children}</div>;
}
