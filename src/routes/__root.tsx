import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext, useRouter } from "@tanstack/react-router";
import { RotateCwIcon, UnplugIcon } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { ConfirmHost } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

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

function RootError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <AuthShell title="Can't reach agentinbox" description="The agentinbox daemon didn't respond. Check that it's running, then try again.">
      <div className="flex flex-col items-center gap-4">
        <div className="flex max-w-full items-center gap-2 rounded-md border bg-background px-3 py-2 font-mono text-xs break-all text-muted-foreground">
          <UnplugIcon className="size-3.5 shrink-0" />
          {error instanceof Error ? error.message : String(error)}
        </div>
        <Button onClick={() => router.invalidate()}>
          <RotateCwIcon /> Try again
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
