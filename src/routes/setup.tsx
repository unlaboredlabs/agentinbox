import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon, InfoIcon, TerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { ErrorAlert } from "@/components/common";
import { MIN_PASSWORD, PasswordInput, StrengthMeter } from "@/components/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError } from "@/lib/api";
import { NPX } from "@/lib/cli";
import { claimView, EMPTY_TOKEN, type TokenCheck, tokenFromInput } from "@/lib/setup-token";
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

const verifyRequest = (token: string) => api("/api/setup/verify-token", { body: { token } });

/** First run: prove you own the server (setup token from the CLI), then choose the admin password. */
function ClaimPage() {
  const linkToken = Route.useSearch().token;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [token, setToken] = useState(linkToken ?? "");
  const [check, setCheck] = useState<TokenCheck>(linkToken ? { status: "checking" } : { status: "idle" });
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const signInRef = useRef<HTMLAnchorElement>(null);

  // A whole pasted setup link works as well as the bare token.
  const cleanToken = tokenFromInput(token);
  const view = claimView(check, !!linkToken && cleanToken === linkToken);

  const verify = async (value: string): Promise<boolean> => {
    setCheck({ status: "checking" });
    try {
      await verifyRequest(value);
      setCheck({ status: "ok" });
      return true;
    } catch (err) {
      setCheck({ status: "error", error: err });
      return false;
    }
  };

  // A setup link: check its token before asking for a password (the initial state is "checking").
  useEffect(() => {
    if (!linkToken) return;
    let live = true;
    verifyRequest(linkToken).then(
      () => live && setCheck({ status: "ok" }),
      (err: unknown) => live && setCheck({ status: "error", error: err }),
    );
    return () => {
      live = false;
    };
  }, [linkToken]);

  // Focus follows the step: the password once verified, the token field after an error, Sign in when claimed.
  useEffect(() => {
    if (view.phase === "verified") passwordRef.current?.focus();
    else if (view.phase === "claimed") signInRef.current?.focus();
    else if (view.tokenError) tokenRef.current?.focus();
  }, [view.phase, view.tokenError]);

  const tooShort = password.length < MIN_PASSWORD;
  const mismatch = confirmPw.length > 0 && confirmPw !== password;
  const valid = !tooShort && confirmPw === password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (view.phase !== "verified") {
      if (check.status === "checking") return;
      if (cleanToken) {
        setToken(cleanToken);
        await verify(cleanToken);
      } else setCheck({ status: "error", error: EMPTY_TOKEN });
      return;
    }
    setTouched(true);
    if (!valid) return;
    setPending(true);
    setError(undefined);
    try {
      await api("/api/setup/claim", { body: { token: cleanToken, password } });
      qc.setQueryData(keys.setupStatus, { claimed: true, authenticated: true });
      await navigate({ to: "/get-started" });
    } catch (err) {
      // The token stopped working in between (reset-password, or claimed elsewhere): ask for it again.
      if (err instanceof ApiError && (err.code === "invalid_token" || err.code === "setup_token_expired" || err.status === 409)) setCheck({ status: "error", error: err });
      else setError(err);
    } finally {
      setPending(false);
    }
  }

  const code = (s: string) => <code className="font-mono text-foreground">{s}</code>;

  return (
    <AuthShell
      title="Welcome to agentinbox"
      description="Secure this console with an admin password. Next, we'll walk through connecting Gmail and your first agent."
    >
      <Card>
        <CardContent>
          <form onSubmit={submit} noValidate>
            <FieldGroup>
              {/* One live region for the token check, so screen readers hear each change. */}
              <div
                role="status"
                aria-live="polite"
                className={view.status && view.phase !== "claimed" ? "flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" : "sr-only"}
              >
                {view.phase === "checking" && <Spinner className="size-4" />}
                {view.phase === "verified" && <CheckCircle2Icon className="size-4 shrink-0 text-success" />}
                <span>{view.status}</span>
              </div>
              {view.phase === "claimed" && (
                <Alert>
                  <InfoIcon />
                  <AlertTitle>This instance is already set up</AlertTitle>
                  <AlertDescription>
                    <p>
                      <Link to="/login" ref={signInRef} className="font-medium underline underline-offset-4">
                        Sign in
                      </Link>{" "}
                      with its admin password. Forgot it? Run {code(`${NPX} reset-password`)} on the server.
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              {view.phase === "enter-token" && (
                <Field data-invalid={!!view.tokenError}>
                  <FieldLabel htmlFor="token">Setup link or token</FieldLabel>
                  <Input
                    id="token"
                    ref={tokenRef}
                    autoFocus={!linkToken}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      if (check.status === "error") setCheck({ status: "idle" });
                    }}
                    aria-invalid={!!view.tokenError}
                    aria-describedby={view.tokenError ? "token-error token-help" : "token-help"}
                  />
                  {view.tokenError && <FieldError id="token-error">{view.tokenError}</FieldError>}
                  <FieldDescription id="token-help" className="space-y-1.5">
                    <span className="flex items-start gap-1.5">
                      <TerminalIcon className="mt-0.5 size-3.5 shrink-0" />
                      <span>Open the setup link that {code(NPX)} printed, or paste the link (or just its token) here.</span>
                    </span>
                    <span className="block">
                      Lost the link? On the server, run {code(`${NPX} reset-password`)} (add {code("--data <dir>")} if you used one): it prints the
                      link again, and before setup it doesn't change anything. If you started it in a terminal, restarting {code(NPX)} prints it too.
                    </span>
                  </FieldDescription>
                </Field>
              )}
              {view.phase === "verified" && (
                <>
                  <Field data-invalid={touched && tooShort}>
                    <FieldLabel htmlFor="password">Admin password</FieldLabel>
                    <PasswordInput
                      id="password"
                      ref={passwordRef}
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
                </>
              )}
              {error !== undefined && <ErrorAlert error={error} />}
              {view.phase !== "claimed" && (
                <Button type="submit" disabled={pending || view.phase === "checking" || (view.phase === "verified" && touched && !valid)}>
                  {(pending || view.phase === "checking") && <Spinner />}
                  {view.submitLabel}
                </Button>
              )}
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
