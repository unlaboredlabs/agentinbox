import type { Account } from "@shared/types";
import { AlertTriangleIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, RefreshCwIcon, Trash2Icon, UnplugIcon } from "lucide-react";
import { TimeAgo } from "@/components/common";
import { useNow } from "@/hooks/use-now";
import { confirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountAvatar, AccountStatusBadge } from "./account-status";
import { connectAccount } from "./connect-host";
import { useAccountActions } from "./use-account-actions";

export function AccountRow({ account: a, showWatch }: { account: Account; showWatch: boolean }) {
  const { resync, pause, resume, remove } = useAccountActions();
  const reconnect = () => connectAccount({ reauthAccountId: a.id, email: a.email });
  const now = useNow(60_000);
  const watchLeft = a.watchExpiresAt ? new Date(a.watchExpiresAt).getTime() - now : null;
  const watchSoon = watchLeft !== null && watchLeft < 12 * 3600_000;

  const askRemove = () =>
    confirm({
      title: `Remove ${a.email}?`,
      destructive: true,
      confirmLabel: "Remove account",
      description: (
        <>
          <p>agentinbox stops syncing this mailbox, revokes its Google token and deletes every agent grant for it. Agents lose access immediately.</p>
          <p>Mail in Gmail isn't touched. You can connect the account again later, but you'll need to recreate its grants.</p>
        </>
      ),
      onConfirm: () => remove.mutateAsync(a),
    });

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <AccountAvatar email={a.email} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{a.email}</span>
            <AccountStatusBadge status={a.status} />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            {a.displayName && <span className="truncate">{a.displayName}</span>}
            <span>
              Last sync <TimeAgo date={a.lastSyncAt} fallback="never" />
            </span>
            {showWatch && (
              <span className={watchSoon ? "text-warning" : undefined}>
                Gmail watch {watchLeft === null ? "" : watchLeft < 0 ? "expired " : "renews "}
                <TimeAgo date={a.watchExpiresAt} fallback="not set" />
              </span>
            )}
            <span>
              Connected <TimeAgo date={a.createdAt} />
            </span>
          </div>
          {a.lastError && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-critical">
              <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
              <span className="break-words">{a.lastError}</span>
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
        {a.status === "needs_reauth" && (
          <Button size="sm" onClick={reconnect}>
            <UnplugIcon /> Reconnect
          </Button>
        )}
        {a.status === "paused" && (
          <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate(a)}>
            <PlayIcon /> Resume
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.email}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={reconnect}>
              <UnplugIcon /> Reconnect
            </DropdownMenuItem>
            <DropdownMenuItem disabled={a.status === "paused"} onSelect={() => resync.mutate(a)}>
              <RefreshCwIcon /> Resync now
            </DropdownMenuItem>
            {a.status === "paused" ? (
              <DropdownMenuItem onSelect={() => resume.mutate(a)}>
                <PlayIcon /> Resume
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => pause.mutate(a)}>
                <PauseIcon /> Pause
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={askRemove}>
              <Trash2Icon /> Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
