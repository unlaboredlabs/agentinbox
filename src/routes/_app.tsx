import { useQueryClient } from "@tanstack/react-query";
import { Outlet, createFileRoute, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { ConnectAccountHost } from "@/components/accounts/connect-host";
import { AppSidebar } from "@/components/app-sidebar";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { ThemeToggle } from "@/components/theme";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { UNAUTHORIZED_EVENT } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { StreamProvider } from "@/lib/stream";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    // Cached briefly so in-app navigation doesn't hit the server each time; a 401 anywhere
    // sends the user to /login regardless.
    const status = await context.queryClient.fetchQuery({ ...queries.setupStatus(), staleTime: 60_000 });
    if (!status.claimed) throw redirect({ to: "/setup" });
    if (!status.authenticated) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: AppLayout,
});

function AppLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.href });

  useEffect(() => {
    const onUnauthorized = () => {
      qc.setQueryData(keys.setupStatus, { claimed: true, authenticated: false });
      void navigate({ to: "/login", search: { redirect: href } });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate, qc, href]);

  return (
    <StreamProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 rounded-t-xl border-b bg-background/80 px-4 backdrop-blur">
            <SidebarTrigger className="-ml-1" />
            <div className="flex-1" />
            <ConnectionIndicator />
            <ThemeToggle />
          </header>
          <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 space-y-6 p-4 md:p-6 lg:p-8">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
      <ConnectAccountHost />
    </StreamProvider>
  );
}
