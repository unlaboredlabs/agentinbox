import { useState } from "react";
import { ErrorAlert } from "@/components/common";
import { MIN_PASSWORD, PasswordInput, StrengthMeter } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";

export function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [touched, setTouched] = useState(false);
  const change = useApiMutation({
    mutationFn: () => api("/api/auth/password", { body: { current, next } }),
    success: "Password changed",
    errorTitle: false,
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setAgain("");
      setTouched(false);
    },
  });
  const tooShort = next.length < MIN_PASSWORD;
  const mismatch = again !== next;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin password</CardTitle>
        <CardDescription>Protects this console. Agents use their own keys and aren't affected.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (current && !tooShort && !mismatch) change.mutate();
          }}
        >
          <FieldGroup className="max-w-sm">
            <Field data-invalid={touched && !current}>
              <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
              <PasswordInput id="pw-current" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field data-invalid={touched && tooShort}>
              <FieldLabel htmlFor="pw-next">New password</FieldLabel>
              <PasswordInput id="pw-next" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
              {next && <StrengthMeter password={next} />}
            </Field>
            <Field data-invalid={touched && mismatch}>
              <FieldLabel htmlFor="pw-again">Confirm new password</FieldLabel>
              <PasswordInput id="pw-again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
              {touched && mismatch && <FieldError>Passwords don't match.</FieldError>}
            </Field>
            {change.isError && <ErrorAlert error={change.error} title="Couldn't change the password" />}
            <div>
              <Button type="submit" disabled={change.isPending || !current || !next}>
                {change.isPending && <Spinner />} Change password
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
