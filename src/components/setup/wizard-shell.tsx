import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ExternalLinkIcon, MinusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { STEP_IDS, STEP_META, type StepId, type StepStatus } from "./progress";

function StepMarker({ index, status, current }: { index: number; status: StepStatus; current: boolean }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular transition-colors",
        status === "done" && "border-success bg-success text-white",
        status === "skipped" && "border-muted-foreground/40 bg-muted text-muted-foreground",
        status === "todo" && current && "border-primary bg-primary text-primary-foreground",
        status === "todo" && !current && "bg-background text-muted-foreground",
      )}
      aria-hidden
    >
      {status === "done" ? <CheckIcon className="size-3.5" /> : status === "skipped" ? <MinusIcon className="size-3.5" /> : index + 1}
    </span>
  );
}

const STATUS_TEXT: Record<StepStatus, string> = { done: "done", skipped: "skipped", todo: "to do" };

/** Vertical stepper on large screens; a compact progress bar + step picker on small ones. */
export function WizardNav({ current, statuses, onSelect }: { current: StepId; statuses: Record<StepId, StepStatus>; onSelect: (id: StepId) => void }) {
  const done = STEP_IDS.filter((id) => statuses[id] !== "todo").length;
  const index = STEP_IDS.indexOf(current);
  return (
    <>
      <div className="space-y-3 lg:hidden">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Step {index + 1} of {STEP_IDS.length}
          </span>
          <span>{done} done</span>
        </div>
        <Progress value={(done / STEP_IDS.length) * 100} aria-label="Setup progress" />
        <Select value={current} onValueChange={(v) => onSelect(v as StepId)}>
          <SelectTrigger className="w-full" aria-label="Jump to step">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STEP_IDS.map((id, i) => (
              <SelectItem key={id} value={id}>
                {i + 1}. {STEP_META[id].short}
                {statuses[id] === "done" ? " ✓" : statuses[id] === "skipped" ? " (skipped)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <nav aria-label="Setup steps" className="hidden lg:block">
        <ol className="space-y-1">
          {STEP_IDS.map((id, i) => {
            const active = id === current;
            return (
              <li key={id} className="relative">
                {i < STEP_IDS.length - 1 && (
                  <span
                    aria-hidden
                    className={cn("absolute top-9 left-[1.4rem] h-[calc(100%-1.75rem)] w-px", statuses[id] === "done" ? "bg-success/50" : "bg-border")}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onSelect(id)}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "relative flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-muted",
                  )}
                >
                  <StepMarker index={i} status={statuses[id]} current={active} />
                  <span className="min-w-0">
                    <span className={cn("block truncate", active ? "font-medium" : "text-muted-foreground")}>{STEP_META[id].short}</span>
                    {STEP_META[id].optional && <span className="block text-xs text-muted-foreground">Optional</span>}
                  </span>
                  <span className="sr-only">({STATUS_TEXT[statuses[id]]})</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}

export function StepCard({
  index,
  title,
  description,
  children,
  footer,
}: {
  index: number;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <div className="space-y-1.5 border-b p-5 sm:p-6">
        <div className="text-xs font-medium text-muted-foreground">
          Step {index + 1} of {STEP_IDS.length}
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <div className="max-w-2xl text-sm text-muted-foreground">{description}</div>
      </div>
      <CardContent className="space-y-6 p-5 sm:p-6">{children}</CardContent>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 p-4 sm:px-6">{footer}</div>
    </Card>
  );
}

export function StepFooter({
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled,
  pending,
  extra,
  hint,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  pending?: boolean;
  extra?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <>
      <div>
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeftIcon /> Back
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        {extra}
        <Button onClick={onNext} disabled={nextDisabled || pending}>
          {pending && <Spinner />}
          {nextLabel} {!pending && <ArrowRightIcon />}
        </Button>
      </div>
    </>
  );
}

/** Numbered instructions for things done outside agentinbox (in Google Cloud). */
export function Guide({ children }: { children: React.ReactNode }) {
  return <ol className="space-y-5 [counter-reset:guide]">{children}</ol>;
}

export function GuideStep({ title, children, done }: { title: React.ReactNode; children?: React.ReactNode; done?: boolean }) {
  return (
    <li className="relative flex gap-3 [counter-increment:guide]">
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-medium tabular before:content-[counter(guide)]",
          done && "border-success bg-success text-white before:content-['✓']",
        )}
      />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="text-sm font-medium">{title}</div>
        {children && <div className="space-y-2 text-sm text-muted-foreground">{children}</div>}
      </div>
    </li>
  );
}

/** A deep link into Google Cloud Console, styled as a button. */
export function CloudLink({ href, children, disabled }: { href: string; children: React.ReactNode; disabled?: boolean }) {
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ExternalLinkIcon />
        <span className="sr-only">(opens Google Cloud in a new tab)</span>
      </a>
    </Button>
  );
}

