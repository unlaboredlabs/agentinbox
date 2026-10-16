import { ThemeToggle } from "@/components/theme";
import { cn } from "@/lib/utils";

/** xaq mark: an envelope with an agent "presence" dot. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <rect x="7.5" y="10" width="17" height="12.5" rx="2" className="stroke-primary-foreground" strokeWidth="2" />
      <path
        d="M8.5 11.5 16 17l7.5-5.5"
        className="stroke-primary-foreground"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24.5" cy="9" r="3.5" className="fill-chart-1 stroke-primary" strokeWidth="1.5" />
    </svg>
  );
}

export function AuthShell({
  title,
  description,
  children,
  wide,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center bg-muted/40 p-4 sm:p-6">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className={cn("w-full space-y-6", wide ? "max-w-md" : "max-w-sm")}>
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo className="size-10" />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-balance text-muted-foreground">{description}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
