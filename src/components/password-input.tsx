import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export function PasswordInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <InputGroup className={className}>
      <InputGroupInput type={shown ? "text" : "password"} {...props} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label={shown ? "Hide password" : "Show password"} onClick={() => setShown(!shown)}>
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export const MIN_PASSWORD = 10;

/** Rough strength estimate: length dominates, character variety helps, obvious patterns hurt. */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string; hint: string } {
  if (!pw) return { score: 0, label: "", hint: `Use at least ${MIN_PASSWORD} characters. A short passphrase of random words works well.` };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let points = Math.min(4, Math.floor(pw.length / 4)) + classes - 1;
  if (/^(.)\1+$/.test(pw) || /^(password|letmein|qwerty|123456|admin)/i.test(pw)) points = 0;
  if (/(.)\1{3,}/.test(pw)) points -= 1;
  if (pw.length < MIN_PASSWORD) points = Math.min(points, 1);
  const score = Math.max(1, Math.min(4, Math.round(points / 1.75))) as 1 | 2 | 3 | 4;
  const table = {
    1: { label: "Too weak", hint: pw.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : "Avoid common words and repeats." },
    2: { label: "Fair", hint: "Longer is stronger: add a few more words or characters." },
    3: { label: "Good", hint: "Solid. Store it in your password manager." },
    4: { label: "Strong", hint: "Great. Store it in your password manager." },
  } as const;
  return { score, ...table[score] };
}

export function StrengthMeter({ password }: { password: string }) {
  const { score, label, hint } = passwordStrength(password);
  const color = ["bg-muted", "bg-critical", "bg-warning", "bg-chart-1", "bg-success"][score];
  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i <= score ? color : "bg-muted")} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {label && <span className="font-medium text-foreground">{label}. </span>}
        {hint}
      </p>
    </div>
  );
}
