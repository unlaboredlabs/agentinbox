import { useEffect, useState } from "react";
import { type Account, EVENT_TYPES, type EventType, type WebhookFilter } from "@shared/types";
import { ShieldAlertIcon } from "lucide-react";
import { ChipsInput } from "@/components/chips-input";
import { LabelMultiSelect } from "@/components/label-multi-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EVENT_TYPE_INFO } from "@/lib/labels";
import { regexError } from "@/lib/webhook-filter";

export function EventTypePicker({ value, onChange, invalid }: { value: EventType[]; onChange: (v: EventType[]) => void; invalid?: boolean }) {
  const toggle = (t: EventType, on: boolean) => onChange(EVENT_TYPES.filter((x) => (x === t ? on : value.includes(x))));
  return (
    <FieldSet data-invalid={invalid}>
      <FieldLegend variant="label">Events</FieldLegend>
      <div className="grid gap-1.5">
        {EVENT_TYPES.map((t) => (
          <label
            key={t}
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 has-[[data-state=checked]]:bg-muted/40"
          >
            <Checkbox className="mt-0.5" checked={value.includes(t)} onCheckedChange={(v) => toggle(t, v === true)} />
            <span className="min-w-0 space-y-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                {EVENT_TYPE_INFO[t].label}
                <code className="font-mono text-xs font-normal text-muted-foreground">{t}</code>
              </span>
              <span className="block text-xs text-muted-foreground">{EVENT_TYPE_INFO[t].description}</span>
            </span>
          </label>
        ))}
      </div>
      {invalid && <FieldError>Pick at least one event type.</FieldError>}
    </FieldSet>
  );
}

const globError = (v: string) => (/\s/.test(v) ? "no spaces allowed" : v.length > 254 ? "too long" : null);

/** Which messages a webhook fires for. Every set condition must match; within a list, any entry matches. */
export function FilterBuilder({
  value,
  onChange,
  accounts,
  onPendingChange,
}: {
  value: WebhookFilter;
  onChange: (f: WebhookFilter) => void;
  accounts: Account[];
  /** Sender/recipient text typed but not added yet. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const [typing, setTyping] = useState({ from: false, to: false });
  const pending = typing.from || typing.to;
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  const set = (patch: Partial<WebhookFilter>) => onChange({ ...value, ...patch });
  const accountIds = value.accountIds ?? [];
  const subjectError = regexError(value.subject);
  const toggleAccount = (id: string, on: boolean) =>
    set({ accountIds: on ? [...new Set([...accountIds, id])] : accountIds.filter((x) => x !== id) });

  return (
    <div className="space-y-5">
      <FieldSet>
        <FieldLegend variant="label">Accounts</FieldLegend>
        <FieldDescription>Leave all unchecked for every account the agent can read. Accounts it has no read grant for are never sent.</FieldDescription>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {accounts.map((a) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
              <Checkbox checked={accountIds.includes(a.id)} onCheckedChange={(v) => toggleAccount(a.id, v === true)} />
              <span className="truncate">{a.email}</span>
            </label>
          ))}
        </div>
      </FieldSet>

      <Field>
        <FieldLabel htmlFor="wf-labels">Labels</FieldLabel>
        <LabelMultiSelect
          id="wf-labels"
          accountIds={accountIds.length ? accountIds : accounts.map((a) => a.id)}
          value={value.labelIds ?? []}
          onChange={(labelIds) => set({ labelIds })}
          placeholder="Any label"
        />
        <FieldDescription>Fire only for messages carrying any of these labels.</FieldDescription>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="wf-from">From</FieldLabel>
          <ChipsInput id="wf-from" value={value.from ?? []} onChange={(from) => set({ from })} placeholder="Any sender" validate={globError} onPendingChange={(v) => setTyping((t) => ({ ...t, from: v }))} />
          <FieldDescription>
            Globs like <code className="font-mono">*@stripe.com</code>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="wf-to">To or Cc</FieldLabel>
          <ChipsInput id="wf-to" value={value.to ?? []} onChange={(to) => set({ to })} placeholder="Any recipient" validate={globError} onPendingChange={(v) => setTyping((t) => ({ ...t, to: v }))} />
          <FieldDescription>
            e.g. <code className="font-mono">support@yourco.com</code>
          </FieldDescription>
        </Field>
      </div>

      <Field data-invalid={!!subjectError}>
        <FieldLabel htmlFor="wf-subject">Subject pattern (RE2 regular expression)</FieldLabel>
        <Input
          id="wf-subject"
          className="font-mono"
          placeholder="e.g. invoice|receipt"
          spellCheck={false}
          value={value.subject ?? ""}
          onChange={(e) => set({ subject: e.target.value })}
          aria-invalid={!!subjectError}
        />
        {subjectError ? (
          <FieldError>Not a valid pattern: {subjectError}</FieldError>
        ) : (
          <FieldDescription>
            Case-insensitive, checked against the first 256 characters of the subject. RE2 syntax: no lookarounds or backreferences. Leave empty for any
            subject.
          </FieldDescription>
        )}
      </Field>

      <Field>
        <FieldLabel>Attachments</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={value.hasAttachments === undefined ? "any" : value.hasAttachments ? "with" : "without"}
          onValueChange={(v) => v && set({ hasAttachments: v === "any" ? undefined : v === "with" })}
          aria-label="Attachments"
        >
          <ToggleGroupItem value="any">Any</ToggleGroupItem>
          <ToggleGroupItem value="with">With attachments</ToggleGroupItem>
          <ToggleGroupItem value="without">Without</ToggleGroupItem>
        </ToggleGroup>
      </Field>
    </div>
  );
}

export function IncludeBodyField({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="space-y-2">
      <Field orientation="horizontal">
        <Switch id="wf-body" checked={value} onCheckedChange={onChange} />
        <div className="space-y-0.5">
          <FieldLabel htmlFor="wf-body">Include message body</FieldLabel>
          <FieldDescription>Adds the message as clean Markdown, plus attachment info and safety signals, so the agent can act without a fetch.</FieldDescription>
        </div>
      </Field>
      {value && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <ShieldAlertIcon className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            Bodies are cleaned (hidden text and invisible characters removed) but are still <strong>untrusted input</strong>: anyone can
            email you. Your receiver should treat the content as data, never as instructions.
          </span>
        </p>
      )}
    </div>
  );
}
