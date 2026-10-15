import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { ErrorAlert } from "@/components/common";
import { MIN_PASSWORD, PasswordInput, StrengthMeter } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { keys, queries } from "@/lib/queries";

export const Route = createFileRoute("/setup")({
  validateSearch: (s: Record<string, unknown>): { token?: string } => ({
    token: typeof s.token === "string" && s.token ? s.token : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(queries.setupStatus());
    if (status.claimed) throw redirect({ to: status.authenticated ? "/" : "/login" });
  },
  component: ClaimPage,
});

/** First run: prove you own the server (setup token from the CLI) and choose the admin password. */
function ClaimPage() {
  const linkToken = Route.useSearch().token;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [token, setToken] = useState(linkToken ?? "");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);

  const tooShort = password.length < MIN_PASSWORD;
  const mismatch = confirmPw.length > 0 && confirmPw !== password;
  const valid = token.trim() && !tooShort && confirmPw === password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    setPending(true);
    setError(undefined);
    try {
      await api("/api/setup/claim", { body: { token: token.trim(), password } });
      qc.setQueryData(keys.setupStatus, { claimed: true, authenticated: true });
      await navigate({ to: "/get-started" });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Welcome to agentinbox"
      description="Secure this console with an admin password. Next, we'll walk through connecting Gmail and your first agent."
    >
      <Card>
        <CardContent>
          <form onSubmit={submit} noValidate>
            <FieldGroup>
              {linkToken ? (
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                  <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                  <span>Setup link verified from the terminal.</span>
                </div>
              ) : (
                <Field data-invalid={touched && !token.trim()}>
                  <FieldLabel htmlFor="token">Setup token</FieldLabel>
                  <Input
                    id="token"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    aria-invalid={touched && !token.trim()}
                  />
                  <FieldDescription className="flex items-start gap-1.5">
                    <TerminalIcon className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Open the setup link that <code className="font-mono text-foreground">npx agentinbox</code> printed, or paste its token here.
                    </span>
                  </FieldDescription>
                </Field>
              )}
              <Field data-invalid={touched && tooShort}>
                <FieldLabel htmlFor="password">Admin password</FieldLabel>
                <PasswordInput
                  id="password"
                  autoFocus={!!linkToken}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={touched && tooShort}
                />
                <StrengthMeter password={password} />
              </Field>
              <Field data-invalid={mismatch || (touched && confirmPw !== password)}>
                <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
                <PasswordInput
                  id="confirm"
                  autoComplete="new-password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  aria-invalid={mismatch || (touched && confirmPw !== password)}
                />
                {(mismatch || (touched && confirmPw !== password)) && <FieldError>Passwords don't match.</FieldError>}
              </Field>
              {error !== undefined && <ErrorAlert error={error} />}
              <Button type="submit" disabled={pending || (touched && !valid)}>
                {pending && <Spinner />}
                Create admin password
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <p className="text-center text-xs text-balance text-muted-foreground">
        The password protects this console only. Agents get their own scoped API keys later.
      </p>
    </AuthShell>
  );
}
