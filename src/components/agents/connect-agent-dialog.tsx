import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { StatusDot } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { queries } from "@/lib/queries";
import { ConnectAgentGuide } from "./connect-agent-guide";

/** "Connect an agent": the pairing flow, with a live hint when a request arrives. */
export function ConnectAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pairings = useQuery({ ...queries.pairings("pending"), enabled: open });
  const waiting = pairings.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect an agent</DialogTitle>
          <DialogDescription>
            The agent asks for access from its own terminal and you approve it here. Its key never passes through your clipboard.
          </DialogDescription>
        </DialogHeader>
        <ConnectAgentGuide />
        <DialogFooter className="items-center sm:justify-between">
          {waiting.length > 0 ? (
            <Button asChild>
              <Link to="/approvals" search={{ tab: "access" }}>
                <StatusDot tone="warn" pulse />
                {waiting.length === 1 ? `${waiting[0]!.name} is waiting` : `${waiting.length} requests are waiting`}
                <ArrowRightIcon />
              </Link>
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <StatusDot tone="idle" pulse />
              Waiting for a request…
            </span>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
