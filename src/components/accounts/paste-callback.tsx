import type { Account, ConnectAccountResponse } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { queries } from "@/lib/queries";
import { GoogleErrorHelp } from "./google-error-help";

/** Checks a pasted redirect URL before sending it; returns a problem description or null. */
function checkPasted(value: string, state: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "That isn't a full address. Copy everything in the address bar, starting with http.";
  }
  const err = url.searchParams.get("error");
  if (err)
    return err === "access_denied"
      ? "This address says you clicked Cancel (or denied access) on Google's screen. Nothing needs fixing: start again and click Continue."
      : `Google returned an error: ${err}`;
  if (!url.searchParams.get("code")) return "This address has no authorization code. Make sure you copied it after clicking Allow.";
  const s = url.searchParams.get("state");
  if (s && s !== state) return "This address belongs to an older sign-in attempt. Use the newest one.";
  return null;
}

/**
 * Paste mode: the public URL is plain http on a non-localhost host, so Google can't redirect back here.
 * The user signs in in a new tab, lands on an unreachable page, and pastes that address back.
 */
export function PasteCallback({
  res,
  onConnected,
  compact,
}: {
  res: ConnectAccountResponse;
  /** Called with the connected account's email. */
  onConnected: (email: string) => void;
  /** Only the paste field (the fallback in pop-up mode, where sign-in was already opened). */
  compact?: boolean;
}) {
  const client = useQuery(queries.googleClient());
  const placeholder = `${client.data?.redirectUri ?? "http://localhost:8425/oauth/callback"}?state=…&code=…`;
  const [opened, setOpened] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const problem = value.trim() ? checkPasted(value, res.state) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || problem) return;
    setPending(true);
    setError(undefined);
    try {
      onConnected((await api<Account>("/api/accounts/connect/complete", { body: { url: value.trim() } })).email);
    } catch (err) {
      // Pasted after the pop-up (or an earlier paste) already finished it: that's the success it looks like.
      if (err instanceof ApiError && err.code === "oauth_already_connected") onConnected(err.email ?? "The account");
      else setError(err);
    } finally {
      setPending(false);
    }
  };

  const field = (label: React.ReactNode) => (
    <Field className="min-w-0 flex-1" data-invalid={!!problem}>
      <FieldLabel htmlFor={compact ? "pasted-url-fallback" : "pasted-url"}>{label}</FieldLabel>
      <Textarea
        id={compact ? "pasted-url-fallback" : "pasted-url"}
        rows={3}
        spellCheck={false}
        placeholder={placeholder}
        className="font-mono text-xs break-all"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={!!problem}
      />
      {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>It contains a one-time code; it can't be reused.</FieldDescription>}
    </Field>
  );
  const finishButton = (
    <Button type="submit" disabled={!value.trim() || !!problem || pending} variant={compact ? "outline" : "default"}>
      {pending && <Spinner />}
      Finish connecting
    </Button>
  );

  if (compact) {
    return (
      <form onSubmit={submit} className="space-y-3">
        {field("Copy the full address from the sign-in window's address bar and paste it here")}
        {error !== undefined && <ErrorAlert error={error} title="Couldn't finish connecting" />}
        <div className="flex justify-end">{finishButton}</div>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ol className="space-y-4 text-sm">
        <li className="flex gap-3">
          <StepNum n={1} />
          <div className="min-w-0 flex-1 space-y-2">
            <p>Open Google sign-in and allow access.</p>
            <Button asChild variant={opened ? "outline" : "default"} size="sm">
              <a href={res.authUrl} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
                <ExternalLinkIcon /> {opened ? "Open sign-in again" : "Open Google sign-in"}
              </a>
            </Button>
          </div>
        </li>
        <li className="flex gap-3">
          <StepNum n={2} />
          <p className="min-w-0 flex-1">
            After you click <strong>Allow</strong>, the tab lands on a page that probably won't load (like "This site can't be reached"). That's expected.
          </p>
        </li>
        <li className="flex gap-3">
          <StepNum n={3} />
          {field("Copy the full address from that tab's address bar and paste it here")}
        </li>
      </ol>
      {error !== undefined && <ErrorAlert error={error} title="Couldn't finish connecting" />}
      <div className="flex justify-end">{finishButton}</div>
      <GoogleErrorHelp />
    </form>
  );
}

function StepNum({ n }: { n: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-medium tabular" aria-hidden>
      {n}
    </span>
  );
}
