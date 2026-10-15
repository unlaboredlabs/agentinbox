import type { Settings } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/common";
import { publicUrlError } from "@/components/settings/settings-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { updateDraft } from "./progress";
import { StepCard, StepFooter } from "./wizard-shell";

export interface StepProps {
  index: number;
  onBack?: () => void;
  onNext: () => void;
}

type UrlKind = "https" | "localhost" | "http";

function classify(url: string): UrlKind | null {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return "https";
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? "localhost" : "http";
  } catch {
    return null;
  }
}

function UrlVerdict({ kind }: { kind: UrlKind }) {
  if (kind === "https")
    return (
      <Alert variant="success">
        <CheckCircle2Icon />
        <AlertTitle>HTTPS: everything works directly</AlertTitle>
        <AlertDescription>Google redirects straight back here after sign-in, and agents anywhere can reach the MCP endpoint.</AlertDescription>
      </Alert>
    );
  if (kind === "localhost")
    return (
      <Alert variant="info">
        <InfoIcon />
        <AlertTitle>Localhost: fine if your agents run on this machine</AlertTitle>
        <AlertDescription>
          Google sign-in redirects back directly. Agents on other machines can't reach localhost, though; if they run elsewhere, use this machine's
          network address or an HTTPS address instead.
        </AlertDescription>
      </Alert>
    );
  return (
    <Alert variant="warning">
      <AlertTriangleIcon />
      <AlertTitle>Plain HTTP on a network address: works, with one extra step</AlertTitle>
      <AlertDescription>
        Google only redirects to HTTPS or localhost addresses. When you connect a Gmail account, you'll copy the address your browser lands on and
        paste it back here ("paste mode"). Everything else works normally. To skip that step, put agentinbox behind HTTPS (for example Caddy,
        Tailscale Serve or Cloudflare Tunnel).
      </AlertDescription>
    </Alert>
  );
}

export function StepUrl({ index, onNext }: StepProps) {
  const settings = useQuery(queries.settings());
  const system = useQuery(queries.system());
  if (settings.isPending) return <Skeleton className="h-96 rounded-xl" />;
  if (settings.isError) return <ErrorAlert error={settings.error} title="Couldn't load settings" />;
  return <UrlForm index={index} onNext={onNext} settings={settings.data} addresses={system.data?.addresses ?? []} />;
}

function UrlForm({ index, onNext, settings, addresses }: StepProps & { settings: Settings; addresses: string[] }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(settings.publicUrl);
  const error = publicUrlError(url);
  const kind = error ? null : classify(url.trim());
  const suggestions = [...new Set([window.location.origin, ...addresses])].filter((a) => a !== url);

  const save = useApiMutation({
    mutationFn: (publicUrl: string) => api<Settings>("/api/settings", { method: "PATCH", body: { publicUrl } }),
    errorTitle: "Couldn't save the public URL",
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s);
      for (const k of [keys.googleClient, keys.system]) void qc.invalidateQueries({ queryKey: k });
      updateDraft({ urlConfirmed: true });
      onNext();
    },
  });

  const next = () => {
    if (error) return;
    const clean = url.trim().replace(/\/+$/, "");
    if (clean === settings.publicUrl) {
      updateDraft({ urlConfirmed: true });
      onNext();
    } else save.mutate(clean);
  };

  return (
    <StepCard
      index={index}
      title="Confirm the public URL"
      description="The address of this agentinbox instance. Google sends you back to it after sign-in, and it's the MCP endpoint you give your agents."
      footer={<StepFooter onNext={next} nextDisabled={!!error} pending={save.isPending} nextLabel="Looks right" />}
    >
      <Field data-invalid={!!error}>
        <FieldLabel htmlFor="setup-url">Public URL</FieldLabel>
        <Input
          id="setup-url"
          className="font-mono"
          inputMode="url"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && next()}
          aria-invalid={!!error}
        />
        {error ? <FieldError>{error}</FieldError> : <FieldDescription>Agents will connect to {url.trim().replace(/\/+$/, "")}/mcp</FieldDescription>}
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
            <span>Use:</span>
            {suggestions.map((a) => (
              <Button key={a} type="button" variant="outline" size="xs" className="font-mono" onClick={() => setUrl(a)}>
                {a}
              </Button>
            ))}
          </div>
        )}
      </Field>
      {kind && <UrlVerdict kind={kind} />}
      <p className="text-xs text-muted-foreground">You can change this later in Settings. If you do, update the redirect URI on your Google OAuth client too.</p>
    </StepCard>
  );
}
