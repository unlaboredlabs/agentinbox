import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { AlertCircleIcon, LockIcon } from "lucide-react";
import { useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api } from "@/lib/api";
import { keys, queries } from "@/lib/queries";

/** Only a path on this console, never another origin (also rejects "//host" and "/\\host" tricks). */
function safeRedirect(r: unknown): string | undefined {
  if (typeof r !== "string" || !r.startsWith("/")) return undefined;
  try {
    const url = new URL(r, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/")) return undefined;
    return url.pathname + url.search + url.hash;
  } catch {
    return undefined;
  }
}

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({ redirect: safeRedirect(s.redirect) }),
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(queries.setupStatus());
    if (!status.claimed) throw redirect({ to: "/setup" });
    if (status.authenticated) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { redirect: to } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | Error>();
  const [pending, setPending] = useState(false);
  const locked = error instanceof ApiError && error.status === 429;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await api("/api/auth/login", { body: { password } });
      qc.setQueryData(keys.setupStatus, { claimed: true, authenticated: true });
      router.history.push(to ?? "/");
    } catch (err) {
      setError(err as Error);
      setPassword("");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell title="Sign in to agentinbox" description="Enter the admin password you chose during setup.">
      <Card>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="password">Admin password</FieldLabel>
                <PasswordInput
                  id="password"
                  autoFocus
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!error && !locked}
                />
                <FieldDescription>
                  Forgot it? Run <code className="font-mono text-foreground">npx agentinbox-cli reset-password</code> on the server.
                </FieldDescription>
              </Field>
              {error && (
                <Alert variant={locked ? "warning" : "destructive"}>
                  {locked ? <LockIcon /> : <AlertCircleIcon />}
                  <AlertTitle>{locked ? "Too many attempts" : error.message}</AlertTitle>
                  {(locked || (error instanceof ApiError && error.hint)) && (
                    <AlertDescription>
                      {locked ? (
                        <>
                          {error.message} Sign-in is locked for this address for a while to stop password guessing.
                          {error instanceof ApiError && error.hint && <> {error.hint}</>}
                        </>
                      ) : (
                        error instanceof ApiError && error.hint
                      )}
                    </AlertDescription>
                  )}
                </Alert>
              )}
              <Button type="submit" disabled={!password || pending}>
                {pending && <Spinner />}
                Sign in
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
