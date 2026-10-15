import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
  value: T;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: React.ReactNode;
}

/** Radio group rendered as selectable cards: arrow keys move between them, Space selects. */
export function ChoiceCards<T extends string>({
  value,
  onChange,
  choices,
  className,
  columns = 1,
  "aria-label": ariaLabel,
}: {
  value: T | undefined;
  onChange: (v: T) => void;
  choices: Choice<T>[];
  className?: string;
  columns?: 1 | 2;
  "aria-label"?: string;
}) {
  return (
    <RadioGroupPrimitive.Root
      value={value ?? ""}
      onValueChange={(v) => onChange(v as T)}
      aria-label={ariaLabel}
      className={cn("grid gap-2", columns === 2 && "sm:grid-cols-2", className)}
    >
      {choices.map((c) => (
        <RadioGroupPrimitive.Item
          key={c.value}
          value={c.value}
          className={cn(
            "group flex w-full items-start gap-3 rounded-lg border bg-card p-3 text-left text-sm transition-colors outline-none",
            "hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "data-[state=checked]:border-primary data-[state=checked]:bg-muted/40 data-[state=checked]:ring-1 data-[state=checked]:ring-primary",
          )}
        >
          <span
            aria-hidden
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-data-[state=checked]:border-primary"
          >
            <span className="size-2 rounded-full bg-primary opacity-0 transition-opacity group-data-[state=checked]:opacity-100" />
          </span>
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-2 font-medium">
              {c.icon && <c.icon className="size-4 text-muted-foreground" />}
              {c.title}
              {c.badge}
            </span>
            {c.description && <span className="block text-xs leading-relaxed text-muted-foreground">{c.description}</span>}
          </span>
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
