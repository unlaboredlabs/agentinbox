import type { GoogleAppType, GoogleClientConfig, GoogleClientView } from "@shared/types";
import { CheckCircle2Icon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/common";
import { PasswordInput } from "@/components/password-input";
import { PROJECT_ID_RE } from "@/components/setup/progress";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys } from "@/lib/queries";
import { rememberClientRedirect } from "./redirect-notice";

/** Last characters of the saved secret, when the server reports them (newer servers). */
export const secretHintOf = (v: GoogleClientView | undefined) => (v as (GoogleClientView & { secretHint?: string | null }) | undefined)?.secretHint ?? null;

export const CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export function clientIdError(v: string) {
  if (!v.trim()) return "Paste the client ID from Google Cloud.";
  if (!CLIENT_ID_RE.test(v.trim())) return "Client IDs look like 1234567890-abc123.apps.googleusercontent.com";
  return null;
}

export function projectIdError(v: string) {
  if (!v.trim()) return "Enter the project ID.";
  if (!PROJECT_ID_RE.test(v.trim()))
    return "Project IDs are 6–30 lowercase letters, digits or hyphens, starting with a letter (e.g. agentinbox-123456). Use the ID, not the display name.";
  return null;
}

/**
 * OAuth client credentials. The secret is write-only: once saved, the field shows a "saved" state
 * and is only sent again if the user types a new one.
 */
export function ClientForm({
  view,
  projectId: fixedProjectId,
  appType: fixedAppType,
  onSaved,
  submitLabel = "Save client",
  onCancel,
}: {
  view: GoogleClientView | undefined;
  /** When given (from the wizard), these aren't editable here. */
  projectId?: string;
  appType?: GoogleAppType;
  onSaved?: (v: GoogleClientView) => void;
  submitLabel?: string;
  onCancel?: () => void;
}) {
  const [clientId, setClientId] = useState(view?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [projectId, setProjectId] = useState(fixedProjectId ?? view?.projectId ?? "");
  const [appType, setAppType] = useState<GoogleAppType | undefined>(fixedAppType ?? view?.appType ?? undefined);
  const [touched, setTouched] = useState(false);
  const hasSecret = !!view?.hasSecret;

  const save = useApiMutation({
    mutationFn: (cfg: GoogleClientConfig) => api<GoogleClientView>("/api/google/client", { method: "PUT", body: cfg }),
    invalidate: [keys.googleClient, keys.setupState],
    success: "OAuth client saved",
    errorTitle: false,
    onSuccess: (v) => {
      setSecret("");
      rememberClientRedirect(v);
      onSaved?.(v);
    },
  });

  const errors = {
    clientId: clientIdError(clientId),
    secret: !hasSecret && !secret.trim() ? "Paste the client secret." : null,
    projectId: fixedProjectId ? null : projectIdError(projectId),
    appType: appType ? null : "Choose the audience you picked on the consent screen.",
  };
  const valid = !Object.values(errors).some(Boolean);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || !appType) return;
    save.mutate({
      clientId: clientId.trim(),
      ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
      projectId: projectId.trim(),
      appType,
    });
  };

  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <Field data-invalid={touched && !!errors.clientId}>
          <FieldLabel htmlFor="g-client-id">Client ID</FieldLabel>
          <Input
            id="g-client-id"
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            placeholder="1234567890-abc123.apps.googleusercontent.com"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            aria-invalid={touched && !!errors.clientId}
          />
          {touched && errors.clientId && <FieldError>{errors.clientId}</FieldError>}
        </Field>
        <Field data-invalid={touched && !!errors.secret}>
          <FieldLabel htmlFor="g-client-secret">Client secret</FieldLabel>
          <PasswordInput
            id="g-client-secret"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder={hasSecret ? "Saved. Paste a new secret to replace it" : "GOCSPX-…"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            aria-invalid={touched && !!errors.secret}
          />
          {touched && errors.secret ? (
            <FieldError>{errors.secret}</FieldError>
          ) : hasSecret ? (
            <FieldDescription className="flex items-center gap-1.5">
              <CheckCircle2Icon className="size-3.5 text-success" /> A secret is saved (encrypted)
              {secretHintOf(view) ? `, ending in …${secretHintOf(view)}` : ""}. Paste a new one only to replace it.
            </FieldDescription>
          ) : (
            <FieldDescription>
              Google shows a secret only once. Lost it? In Google Cloud open <strong>Google Auth Platform → Clients</strong> → your client →{" "}
              <strong>Add secret</strong>, and paste the new one here. Stored encrypted.
            </FieldDescription>
          )}
        </Field>
        {!fixedProjectId && (
          <Field data-invalid={touched && !!errors.projectId}>
            <FieldLabel htmlFor="g-project">Project ID</FieldLabel>
            <Input
              id="g-project"
              spellCheck={false}
              className="font-mono"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value.toLowerCase())}
              aria-invalid={touched && !!errors.projectId}
            />
            {touched && errors.projectId && <FieldError>{errors.projectId}</FieldError>}
          </Field>
        )}
        {!fixedAppType && (
          <Field data-invalid={touched && !!errors.appType}>
            <FieldLabel htmlFor="g-apptype">Audience</FieldLabel>
            <Select value={appType} onValueChange={(v) => setAppType(v as GoogleAppType)}>
              <SelectTrigger id="g-apptype" className="w-full" aria-invalid={touched && !!errors.appType}>
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="internal">Internal (Google Workspace users only)</SelectItem>
                <SelectItem value="external">External (any Google account)</SelectItem>
              </SelectContent>
            </Select>
            {touched && errors.appType && <FieldError>{errors.appType}</FieldError>}
          </Field>
        )}
        {save.isError && <ErrorAlert error={save.error} title="Couldn't save the OAuth client" />}
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {submitLabel}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
