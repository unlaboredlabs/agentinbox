import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircleIcon, InboxIcon } from "lucide-react";
import { CodeBlock } from "@/components/common";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { queries } from "@/lib/queries";

/** Version in the sidebar footer; turns into an update notice with the upgrade command when one exists. */
export function ConsoleVersion({ version, service }: { version?: string; service?: boolean }) {
  const { data } = useQuery(queries.systemLatest());

  if (!data?.updateAvailable || !data.latest) {
    return (
      <span className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        <InboxIcon className="size-3.5" />
        agentinbox {version ?? data?.current ?? ""}
      </span>
    );
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-chart-1 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none group-data-[collapsible=icon]:hidden">
          <ArrowUpCircleIcon className="size-3.5" />
          <span className="flex-1">Update available</span>
          <span className="text-muted-foreground">{data.latest}</span>
        </button>
      </DialogTrigger>
      <UpdateDialogContent current={data.current} latest={data.latest} command={data.command} service={service} />
    </Dialog>
  );
}

export function UpdateDialogContent({ current, latest, command, service }: { current: string; latest: string; command: string; service?: boolean }) {
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Update agentinbox</DialogTitle>
        <DialogDescription>
          You're on {current}; the latest release is {latest}.{" "}
          {service
            ? "Run this on the server. It reinstalls the service with the latest version and keeps your data, accounts and agents."
            : "Stop agentinbox, then run this on the server to start the latest version. Your data is kept."}
        </DialogDescription>
      </DialogHeader>
      <CodeBlock code={command} />
    </DialogContent>
  );
}
