import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext, useRouter } from "@tanstack/react-router";
import { RotateCwIcon, UnplugIcon } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { ConfirmHost } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <TooltipProvider delayDuration={300}>
      <Outlet />
      <Toaster position="bottom-right" closeButton />
      <ConfirmHost />
    </TooltipProvider>
  ),
  errorComponent: RootError,
  notFoundComponent: NotFound,
});

/** A code chunk failed to load (often a daemon that restarted on a new version): only a reload fetches the new ones. */
const isChunkLoadError = (error: unknown) =>
  error instanceof TypeError && /dynamically imported module|importing a module script failed|error loading dynamically imported/i.test(error.message);

/**
 * Network failures: the request never got an answer (fetch threw), a proxy in front said the
 * upstream is down (a 502-504 that isn't xaq's own JSON error), or a code chunk failed to load.
 */
function isUnreachable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 0 || (error.status >= 502 && error.status <= 504 && error.code.startsWith("http_"));
  return isChunkLoadError(error) || (error instanceof TypeError && /failed to fetch|networkerror|load failed|network request failed/i.test(error.message));
}

function RootError({ error }: { error: unknown }) {
  const router = useRouter();
  const message = error instanceof Error ? error.message : String(error);
  if (isUnreachable(error)) {
    return (
      <AuthShell title="Can't reach xaq" description="The xaq daemon didn't respond. Check that it's running, then try again.">
        <div className="flex flex-col items-center gap-4">
          <div className="flex max-w-full items-center gap-2 rounded-md border bg-background px-3 py-2 font-mono text-xs break-all text-muted-foreground">
            <UnplugIcon className="size-3.5 shrink-0" />
            {message}
          </div>
          <Button onClick={() => (isChunkLoadError(error) ? window.location.reload() : void router.invalidate())}>
            <RotateCwIcon /> Try again
          </Button>
        </div>
      </AuthShell>
    );
  }
  const stack = error instanceof Error && error.stack && !(error instanceof ApiError) ? error.stack : null;
  return (
    <AuthShell
      wide
      title="Something went wrong on this page"
      description="The console hit an error showing this page. xaq itself is still running; reloading usually fixes it."
    >
      <div className="flex flex-col items-center gap-4">
        <details className="w-full rounded-md border bg-background text-xs">
          <summary className="cursor-pointer px-3 py-2 text-muted-foreground select-none">Error details</summary>
          <pre className="max-h-64 overflow-auto border-t px-3 py-2 font-mono break-words whitespace-pre-wrap text-foreground">
            {stack?.includes(message) ? stack : [message, stack].filter(Boolean).join("\n")}
          </pre>
        </details>
        <Button onClick={() => window.location.reload()}>
          <RotateCwIcon /> Reload
        </Button>
      </div>
    </AuthShell>
  );
}

function NotFound() {
  return (
    <AuthShell title="Page not found" description="There's nothing at this address.">
      <div className="flex justify-center">
        <Button asChild>
          <Link to="/">Go to overview</Link>
        </Button>
      </div>
    </AuthShell>
  );
}
