import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, MoreHorizontalIcon, NetworkIcon, PauseIcon, PlayIcon, Trash2Icon, UnplugIcon, WrenchIcon } from "lucide-react";
import { useState } from "react";
import { ToneBadge } from "@/components/common";
import { confirm } from "@/components/confirm";
import { PasswordInput } from "@/components/password-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { type Connection, keys, type ReconnectResult } from "@/lib/queries";
import { connectConnection } from "./connection-auth";
import { connectionStatusView, hostPort } from "./connection-flow";

const path = (c: Pick<Connection, "id">, rest = "") => `/api/connections/${encodeURIComponent(c.id)}${rest}`;

/** Reconnect: OAuth runs a fresh sign-in; a header connection asks for the new key; an open one just retries. */
export function useReconnect() {
  const [askingKey, setAskingKey] = useState<Connection | null>(null);
  const reconnect = (c: Connection) => {
    if (c.auth === "header") return setAskingKey(c);
    connectConnection({ name: c.displayName, run: () => api<ReconnectResult>(path(c, "/reconnect"), { body: {} }) });
  };
  const dialog = <HeaderReconnectDialog connection={askingKey} onClose={() => setAskingKey(null)} />;
  return { reconnect, dialog };
}

function HeaderReconnectDialog({ connection: c, onClose }: { connection: Connection | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!c || !value.trim()) return;
    const v = value.trim();
    onClose();
    setValue("");
    // The header name stays as connected; the server keeps it.
    connectConnection({ name: c.displayName, run: () => api<ReconnectResult>(path(c, "/reconnect"), { body: { header: { value: v } } }) });
  };
  return (
    <Dialog open={!!c} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Reconnect {c?.displayName}</DialogTitle>
            <DialogDescription>Paste the new API key or token. The old one is replaced.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="reconnect-key">API key or token</FieldLabel>
            <PasswordInput id="reconnect-key" autoFocus autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
            <FieldDescription>Stored encrypted; agents never see it.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              Reconnect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function useConnectionActions() {
  const invalidate = [keys.connections, ["agent-connections"], keys.approvals, keys.overview] as const;
  const disable = useApiMutation({
    mutationFn: (c: Connection) => api<Connection>(path(c, "/disable"), { body: {} }),
    invalidate,
    success: (_, c) => `${c.displayName} is disabled`,
    errorTitle: "Couldn't disable it",
  });
  const enable = useApiMutation({
    mutationFn: (c: Connection) => api<Connection>(path(c, "/enable"), { body: {} }),
    invalidate,
    success: (_, c) => `${c.displayName} is back on`,
    errorTitle: "Couldn't turn it on",
  });
  const remove = useApiMutation({
    mutationFn: (c: Connection) => api(path(c), { method: "DELETE" }),
    invalidate,
    success: (_, c) => `${c.displayName} is removed`,
    errorTitle: "Couldn't remove it",
  });
  const askRemove = (c: Connection, after?: () => void) =>
    confirm({
      title: `Remove ${c.displayName}?`,
      destructive: true,
      confirmLabel: "Remove now",
      description: (
        <>
          <p>This is the kill switch. Right away, agentinbox:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>stops every agent from using its tools,</li>
            <li>cancels its calls waiting for approval,</li>
            <li>signs out of {c.displayName} and deletes the stored credentials.</li>
          </ul>
          <p>The audit log keeps what happened. To pause it instead, use Disable.</p>
        </>
      ),
      onConfirm: async () => {
        await remove.mutateAsync(c);
        after?.();
      },
    });
  return { disable, enable, askRemove };
}

/** One row of the Connections page: status, private-network badge, tool and held counts, and the fixes. */
export function ConnectionRow({ connection: c }: { connection: Connection }) {
  const now = useNow(60_000);
  const view = connectionStatusView(c, now);
  const { disable, enable, askRemove } = useConnectionActions();
  const { reconnect, dialog } = useReconnect();
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to="/connections/$connectionId" params={{ connectionId: c.id }} className="truncate font-medium hover:underline">
            {c.displayName}
          </Link>
          <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
          {c.privateTarget && (
            <Badge variant="outline" title={`Allowed on your private network: ${hostPort(c.privateTarget)}`}>
              <NetworkIcon /> Private network
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{c.slug}</span>
          <span className="flex items-center gap-1">
            <WrenchIcon className="size-3" /> {c.toolCount} tool{c.toolCount === 1 ? "" : "s"}
          </span>
          {c.url && <span className="max-w-64 truncate">{c.url}</span>}
        </div>
        {c.heldCount > 0 && (
          <Link
            to="/connections/$connectionId"
            params={{ connectionId: c.id }}
            className="mt-2 flex max-w-3xl items-start gap-1.5 rounded-md bg-warning/[0.08] px-2.5 py-1.5 text-xs text-foreground/90 hover:bg-warning/15"
          >
            <AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-warning" />
            <span>
              {c.displayName} changed {c.heldCount} tool{c.heldCount === 1 ? "" : "s"}. {c.heldCount === 1 ? "It's" : "They're"} on hold until you review the change.
            </span>
          </Link>
        )}
        {view.tone === "bad" && (
          <p className="mt-2 flex max-w-3xl items-start gap-1.5 rounded-md bg-critical/[0.06] px-2.5 py-1.5 text-xs text-foreground/90">
            <AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-critical" />
            <span className="break-words">{view.description}</span>
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
        {view.action === "reconnect" && (
          <Button size="sm" onClick={() => reconnect(c)}>
            <UnplugIcon /> Reconnect
          </Button>
        )}
        {view.action === "enable" && (
          <Button size="sm" variant="outline" disabled={enable.isPending} onClick={() => enable.mutate(c)}>
            {enable.isPending ? <Spinner /> : <PlayIcon />} Turn on
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.displayName}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => reconnect(c)}>
              <UnplugIcon /> Reconnect
            </DropdownMenuItem>
            {c.status === "disabled" ? (
              <DropdownMenuItem onSelect={() => enable.mutate(c)}>
                <PlayIcon /> Turn on
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => disable.mutate(c)}>
                <PauseIcon /> Disable
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => askRemove(c)}>
              <Trash2Icon /> Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {dialog}
    </div>
  );
}
