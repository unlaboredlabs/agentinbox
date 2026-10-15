import { type Account, CAPABILITIES, type Capability, type Grant } from "@shared/types";
import { ChevronDownIcon, ShieldOffIcon, ShieldPlusIcon } from "lucide-react";
import { useState } from "react";
import { AccountAvatar, AccountStatusBadge } from "@/components/accounts/account-status";
import { ChipsInput } from "@/components/chips-input";
import { confirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { DEFAULT_GRANT, type GrantFields, grantProblem, sameGrant, toGrantFields, validateAddressGlob } from "@/lib/grants";
import { CAPABILITY_INFO } from "@/lib/labels";
import { useApiMutation } from "@/lib/mutations";
import { keys } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { grantInWords } from "./grant-words";
import { LabelScopePicker } from "./label-scope-picker";
import { SendModeControl } from "./send-mode-control";

function summary(g: GrantFields) {
  const parts: string[] = [grantInWords(g)];
  if (g.labelScope) parts.push(`${g.labelScope.length} label${g.labelScope.length === 1 ? "" : "s"}`);
  if (g.allowTo.length) parts.push(`${g.allowTo.length} allowed recipient${g.allowTo.length === 1 ? "" : "s"}`);
  if (g.replyOnly) parts.push("replies only");
  return parts;
}

/** One agent's access to one mailbox: collapsed summary, expandable editor, save/remove. */
export function GrantEditor({
  agentId,
  account,
  grant,
  defaultOpen,
}: {
  agentId: string;
  account: Account;
  grant: Grant | undefined;
  defaultOpen?: boolean;
}) {
  const saved = grant ? toGrantFields(grant) : null;
  const [draft, setDraft] = useState<GrantFields | null>(saved);
  const [open, setOpen] = useState(!!defaultOpen && !!grant);
  // Pick up server changes (e.g. after save) when there are no local edits.
  const [lastSaved, setLastSaved] = useState(saved);
  if (JSON.stringify(saved) !== JSON.stringify(lastSaved)) {
    setLastSaved(saved);
    if (!draft || (lastSaved && sameGrant(draft, lastSaved))) setDraft(saved);
  }

  const path = `/api/agents/${encodeURIComponent(agentId)}/grants/${encodeURIComponent(account.id)}`;
  const save = useApiMutation({
    mutationFn: (g: GrantFields) => api<Grant>(path, { method: "PUT", body: { ...g, accountId: account.id } }),
    invalidate: [keys.agents],
    success: grant ? `Permissions for ${account.email} saved` : `${account.email} access granted`,
    errorTitle: "Couldn't save permissions",
    onSuccess: (g) => setDraft(toGrantFields(g)),
  });
  const remove = useApiMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    invalidate: [keys.agents],
    success: `Access to ${account.email} removed`,
    errorTitle: false,
    onSuccess: () => {
      setDraft(null);
      setOpen(false);
    },
  });

  const dirty = !!draft && (!saved || !sameGrant(draft, saved));
  const set = (patch: Partial<GrantFields>) => setDraft((d) => ({ ...(d ?? DEFAULT_GRANT), ...patch }));
  const [typing, setTyping] = useState(false);
  const problem = draft ? (typing ? "Add or clear the recipient you're typing first." : grantProblem(draft)) : null;

  const askRemove = () =>
    confirm({
      title: `Remove access to ${account.email}?`,
      description: "The agent immediately loses every capability on this mailbox, and its webhooks stop receiving events from it.",
      confirmLabel: "Remove access",
      destructive: true,
      onConfirm: () => remove.mutateAsync(),
    });


  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <AccountAvatar email={account.email} className="size-8" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{account.email}</span>
            {account.status !== "active" && <AccountStatusBadge status={account.status} />}
            {dirty && saved && <Badge variant="outline" className="border-warning/50 text-xs font-normal">Unsaved changes</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {saved ? summary(saved).join(" · ") : draft ? "New access, not saved yet" : "No access"}
          </div>
        </div>
        {draft ? (
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Collapse" : "Edit"}
            <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({ ...DEFAULT_GRANT });
              setOpen(true);
            }}
          >
            <ShieldPlusIcon /> Grant access
          </Button>
        )}
      </div>

      {draft && open && (
        <div className="border-t p-4">
          <FieldGroup>
            <GrantFieldsForm idPrefix={account.id} accountId={account.id} value={draft} onChange={set} onPendingChange={setTyping} />

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              {saved ? (
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={askRemove}>
                  <ShieldOffIcon /> Remove access
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                {(dirty || !saved) && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDraft(saved);
                      if (!saved) setOpen(false);
                    }}
                  >
                    {saved ? "Discard changes" : "Cancel"}
                  </Button>
                )}
                {problem && dirty && <span className="self-center text-xs text-warning">{problem}</span>}
                <Button disabled={!dirty || save.isPending || !!problem} onClick={() => save.mutate(draft)}>
                  {save.isPending && <Spinner />}
                  {saved ? "Save permissions" : "Grant access"}
                </Button>
              </div>
            </div>
          </FieldGroup>
        </div>
      )}
    </Card>
  );
}

/** The editable fields of a grant (capabilities, label scope, sending rules), without saving. */
export function GrantFieldsForm({
  idPrefix,
  accountId,
  value,
  onChange,
  onPendingChange,
}: {
  idPrefix: string;
  accountId: string;
  value: GrantFields;
  onChange: (patch: Partial<GrantFields>) => void;
  /** Recipient text typed but not added yet. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const set = onChange;
  const id = (s: string) => `${idPrefix}-${s}`;
  const sends = value.capabilities.includes("send");
  const toggleCap = (c: Capability, on: boolean) => set({ capabilities: CAPABILITIES.filter((x) => (x === c ? on : value.capabilities.includes(x))) });
  return (
    <>
      <FieldSet>
        <FieldLegend variant="label">Capabilities</FieldLegend>
        <div className="grid gap-2 sm:grid-cols-2">
          {CAPABILITIES.map((c) => (
            <label
              key={c}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 has-[[data-state=checked]]:bg-muted/40"
            >
              <Checkbox className="mt-0.5" checked={value.capabilities.includes(c)} onCheckedChange={(v) => toggleCap(c, v === true)} />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{CAPABILITY_INFO[c].label}</span>
                <span className="block text-xs text-muted-foreground">{CAPABILITY_INFO[c].description}</span>
              </span>
            </label>
          ))}
        </div>
        {value.capabilities.length > 0 && !value.capabilities.includes("read") && (
          <FieldDescription className="text-warning">Without Read, the agent can't search or open messages, so most actions will fail.</FieldDescription>
        )}
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Which mail it can see</FieldLegend>
        <FieldDescription>
          Scoping works per thread: the agent sees a whole thread as soon as any message in it carries one of these labels, including
          replies from outside that join the thread later. Searches are limited to the same scope.
        </FieldDescription>
        <LabelScopePicker accountId={accountId} value={value.labelScope} onChange={(labelScope) => set({ labelScope })} />
      </FieldSet>

      <FieldSet disabled={!sends} className={cn(!sends && "opacity-60")}>
        <FieldLegend variant="label">Sending</FieldLegend>
        {!sends && <FieldDescription>Turn on the Send capability to configure how sending works.</FieldDescription>}
        <SendModeControl value={value.sendMode} onChange={(sendMode) => set({ sendMode })} disabled={!sends} />
        <Field>
          <FieldLabel htmlFor={id("allow")}>Allowed recipients</FieldLabel>
          <ChipsInput
            id={id("allow")}
            value={value.allowTo}
            onChange={(allowTo) => set({ allowTo })}
            placeholder="Anyone. Add addresses or *@company.com"
            validate={validateAddressGlob}
            onPendingChange={onPendingChange}
            aria-describedby={id("allow-hint")}
          />
          <FieldDescription id={id("allow-hint")}>
            Leave empty to allow any recipient. Use exact addresses or globs like <code className="font-mono">*@yourcompany.com</code>. Every
            to, cc and bcc address must match.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Switch id={id("reply")} checked={value.replyOnly} onCheckedChange={(replyOnly) => set({ replyOnly })} />
          <div className="space-y-0.5">
            <FieldLabel htmlFor={id("reply")}>Replies only</FieldLabel>
            <FieldDescription>Only allow replying inside threads the agent can already see; no new conversations.</FieldDescription>
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <CapInput id={id("hour")} label="Max sends per hour" value={value.maxSendsPerHour} onChange={(maxSendsPerHour) => set({ maxSendsPerHour })} />
          <CapInput id={id("day")} label="Max sends per day" value={value.maxSendsPerDay} onChange={(maxSendsPerDay) => set({ maxSendsPerDay })} />
        </div>
      </FieldSet>
    </>
  );
}

function CapInput({ id, label, value, onChange }: { id: string; label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        inputMode="numeric"
        placeholder="No limit"
        value={value ?? ""}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "");
          onChange(digits ? Math.min(100_000, Number(digits)) : null);
        }}
        aria-invalid={value === 0}
      />
      {value === 0 && <p className="text-xs text-destructive">Use at least 1, or leave empty for no limit.</p>}
    </Field>
  );
}
