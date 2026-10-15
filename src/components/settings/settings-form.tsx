import type { IngestMode, Settings, SystemInfo } from "@shared/types";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, InfoIcon } from "lucide-react";
import { toast } from "sonner";
import { ChipsInput } from "@/components/chips-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, toastError } from "@/lib/api";
import { keys } from "@/lib/queries";

interface FormValues {
  publicUrl: string;
  ingestMode: IngestMode;
  pollIntervalSeconds: string;
  maxBodyChars: string;
  retentionDays: string;
  approvalTtlHours: string;
  webhookAllowlist: string[];
  /** Not edited here yet: carried through unchanged. */
  pairingEnabled: boolean;
}

const toForm = (s: Settings): FormValues => ({
  publicUrl: s.publicUrl,
  ingestMode: s.ingestMode,
  pollIntervalSeconds: String(s.pollIntervalSeconds),
  maxBodyChars: String(s.maxBodyChars),
  retentionDays: String(s.retentionDays),
  approvalTtlHours: String(s.approvalTtlHours),
  webhookAllowlist: s.webhookAllowlist,
  pairingEnabled: s.pairingEnabled,
});

const fromForm = (v: FormValues): Settings => ({
  publicUrl: v.publicUrl.trim().replace(/\/+$/, ""),
  ingestMode: v.ingestMode,
  pollIntervalSeconds: Number(v.pollIntervalSeconds),
  maxBodyChars: Number(v.maxBodyChars),
  retentionDays: Number(v.retentionDays),
  approvalTtlHours: Number(v.approvalTtlHours),
  webhookAllowlist: v.webhookAllowlist,
  pairingEnabled: v.pairingEnabled,
});

// Mirrors the server's validation (server/settings.ts) so mistakes show before saving.
export function publicUrlError(v: string): string | undefined {
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    return "Enter a full URL, e.g. https://mail.example.com or http://localhost:8425";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Use http or https.";
  if (url.search || url.hash) return "Leave out any ?query or #fragment.";
  return undefined;
}

const intError = (label: string, min: number, max: number) => (v: string) => {
  if (!/^\d+$/.test(v.trim())) return `${label} must be a whole number.`;
  const n = Number(v);
  if (n < min || n > max) return `${label} must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`;
  return undefined;
};

/** True when the URL is plain http on a host other than localhost: Google can't redirect there. */
export function needsPasteMode(publicUrl: string) {
  try {
    const u = new URL(publicUrl);
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const allowlistError = (v: string) => (v.length > 253 ? "too long" : /[/]/.test(v) && !/^[\d.:a-f]+\/\d{1,3}$/i.test(v) ? "use a hostname, IP or CIDR like 10.0.0.0/8" : null);

export function SettingsForm({ settings, system }: { settings: Settings; system: SystemInfo | undefined }) {
  const qc = useQueryClient();
  const form = useForm({
    defaultValues: toForm(settings),
    onSubmit: async ({ value, formApi }) => {
      const next = fromForm(value);
      const patch = Object.fromEntries(
        Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(settings[k as keyof Settings])),
      ) as Partial<Settings>;
      try {
        const saved = await api<Settings>("/api/settings", { method: "PATCH", body: patch });
        qc.setQueryData(keys.settings, saved);
        for (const k of [keys.system, keys.googleClient, keys.setupState]) void qc.invalidateQueries({ queryKey: k });
        formApi.reset(toForm(saved));
        toast.success("Settings saved");
      } catch (err) {
        toastError(err, "Couldn't save settings");
      }
    },
  });

  const initial = JSON.stringify(toForm(settings));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      noValidate
      className="space-y-6"
    >
      <Card>
        <CardHeader>
          <CardTitle>Public URL</CardTitle>
          <CardDescription>
            Where this instance is reachable. Used for the Google OAuth redirect and in the MCP URLs you give agents. Agents on other machines must be
            able to reach it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="publicUrl" validators={{ onChange: ({ value }) => publicUrlError(value) }}>
            {(field) => (
              <Field data-invalid={!field.state.meta.isValid}>
                <FieldLabel htmlFor={field.name}>Public URL</FieldLabel>
                <Input
                  id={field.name}
                  className="font-mono"
                  inputMode="url"
                  spellCheck={false}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-invalid={!field.state.meta.isValid}
                />
                {!field.state.meta.isValid ? (
                  <FieldError>{field.state.meta.errors.join(" ")}</FieldError>
                ) : needsPasteMode(field.state.value) ? (
                  <FieldDescription className="flex items-start gap-1.5">
                    <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span>
                      Plain http on a non-localhost address: Google can't redirect back here after sign-in, so connecting accounts uses paste mode
                      (you paste the address you land on). Use https to avoid that.
                    </span>
                  </FieldDescription>
                ) : (
                  <FieldDescription>MCP endpoint: {field.state.value.replace(/\/+$/, "")}/mcp</FieldDescription>
                )}
                {system && system.addresses.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                    <span>This machine:</span>
                    {system.addresses.map((a) => (
                      <Button key={a} type="button" size="xs" variant="outline" className="font-mono" onClick={() => field.handleChange(a)}>
                        {a}
                      </Button>
                    ))}
                  </div>
                )}
              </Field>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mail sync</CardTitle>
          <CardDescription>How agentinbox learns about new mail.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <form.Field name="ingestMode">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Mode</FieldLabel>
                  <Select value={field.state.value} onValueChange={(v) => field.handleChange(v as IngestMode)}>
                    <SelectTrigger id={field.name} className="w-full sm:w-80">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pubsub">Real-time (Gmail push via Pub/Sub)</SelectItem>
                      <SelectItem value="poll">Polling</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {field.state.value === "pubsub"
                      ? "Needs Pub/Sub provisioned (see below). Gmail notifies within seconds."
                      : "Checks every account's history on an interval. No extra Google setup."}
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
            <form.Field name="pollIntervalSeconds" validators={{ onChange: ({ value }) => intError("Poll interval", 5, 3600)(value) }}>
              {(field) => (
                <NumberField field={field} label="Poll interval" unit="seconds" description="Used in polling mode, and as a safety net in real-time mode." />
              )}
            </form.Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agents and retention</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-6 sm:grid-cols-2">
            <form.Field name="maxBodyChars" validators={{ onChange: ({ value }) => intError("Max body characters", 0, 1_000_000)(value) }}>
              {(field) => (
                <NumberField
                  field={field}
                  label="Max body length"
                  unit="characters"
                  description="Per message returned to agents; longer bodies are truncated (and flagged). 0 = no limit."
                />
              )}
            </form.Field>
            <form.Field name="approvalTtlHours" validators={{ onChange: ({ value }) => intError("Approval expiry", 1, 720)(value) }}>
              {(field) => (
                <NumberField field={field} label="Approvals expire after" unit="hours" description="Unanswered requests are rejected and their drafts deleted." />
              )}
            </form.Field>
            <form.Field name="retentionDays" validators={{ onChange: ({ value }) => intError("Retention", 1, 3650)(value) }}>
              {(field) => (
                <NumberField field={field} label="Keep history for" unit="days" description="Events, webhook deliveries and audit entries older than this are deleted." />
              )}
            </form.Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card id="webhook-allowlist" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Webhook allowlist</CardTitle>
          <CardDescription>
            Webhooks may not target private, loopback or link-local addresses (this stops a webhook URL from probing your network), except hosts
            listed here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="webhookAllowlist">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="allowlist">Allowed private hosts</FieldLabel>
                <ChipsInput id="allowlist" value={field.state.value} onChange={field.handleChange} placeholder="e.g. 10.0.0.0/8, n8n.internal" validate={allowlistError} />
                <FieldDescription className="flex items-start gap-1.5">
                  <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Hostnames, IPs or CIDR ranges, e.g. <code className="font-mono">127.0.0.0/8</code>, <code className="font-mono">192.168.1.0/24</code>,{" "}
                    <code className="font-mono">n8n.internal</code>. Public hosts don't need to be listed.
                  </span>
                </FieldDescription>
              </Field>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <form.Subscribe selector={(s) => [JSON.stringify(s.values) !== initial, s.canSubmit, s.isSubmitting] as const}>
        {([changed, canSubmit, submitting]) =>
          changed ? (
            <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur">
              <span className="text-sm">You have unsaved changes.</span>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => form.reset()}>
                  Discard
                </Button>
                <Button type="submit" disabled={!canSubmit || submitting}>
                  {submitting && <Spinner />} Save settings
                </Button>
              </div>
            </div>
          ) : null
        }
      </form.Subscribe>
    </form>
  );
}

interface NumberFieldApi {
  name: string;
  state: { value: string; meta: { isValid: boolean; errors: unknown[] } };
  handleBlur: () => void;
  handleChange: (v: string) => void;
}

function NumberField({ field, label, unit, description }: { field: NumberFieldApi; label: string; unit: string; description: string }) {
  return (
    <Field data-invalid={!field.state.meta.isValid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <InputGroup className="w-full sm:w-56">
        <InputGroupInput
          id={field.name}
          inputMode="numeric"
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value.replace(/[^\d]/g, ""))}
          aria-invalid={!field.state.meta.isValid}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{unit}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      {!field.state.meta.isValid ? <FieldError>{field.state.meta.errors.join(" ")}</FieldError> : <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}
