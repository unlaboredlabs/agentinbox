import type { ExtensionRegistryEntryView, ExtensionView } from "@shared/extensions";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpCircleIcon, DownloadIcon, LinkIcon, MoreHorizontalIcon, PuzzleIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { PageHeader, QueryError, SectionLabel, TimeAgo, ToneBadge } from "@/components/common";
import { AddExtensionDialog, useRemoveExtension, useUpdateExtension } from "@/components/extensions/extension-dialogs";
import { originView, registryAction, shortCommit, usedByLabel } from "@/components/extensions/extension-logic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/extensions")({
  component: ExtensionsPage,
});

function ExtensionsPage() {
  const [adding, setAdding] = useState(false);
  const installed = useQuery(queries.extensions());
  const registry = useQuery(queries.extensionRegistry());
  const update = useUpdateExtension();
  const remove = useRemoveExtension();
  return (
    <>
      <PageHeader
        title="Extensions"
        description="The integrations xaq can connect to. Official ones come from the xaq-extensions registry, pinned to a commit and a hash; nothing updates without you."
        actions={
          <Button variant="outline" onClick={() => setAdding(true)}>
            <LinkIcon /> Add from URL
          </Button>
        }
      />
      <AddExtensionDialog open={adding} onOpenChange={setAdding} />
      {update.dialog}

      <section className="space-y-2">
        <SectionLabel>Installed</SectionLabel>
        {installed.isPending ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : installed.isError ? (
          <QueryError error={installed.error} onRetry={() => void installed.refetch()} />
        ) : installed.data.length === 0 ? (
          <Card>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PuzzleIcon />
                </EmptyMedia>
                <EmptyTitle>No extensions yet</EmptyTitle>
                <EmptyDescription>Install one from the registry below, or add one from a URL.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </Card>
        ) : (
          <Card className="gap-0 py-0">
            <div className="divide-y">
              {installed.data.map((e) => (
                <InstalledRow key={e.name} e={e} checking={update.pending === e.name} onUpdate={() => void update.check(e.name)} onRemove={() => remove(e)} />
              ))}
            </div>
          </Card>
        )}
      </section>

      <section className="space-y-2">
        <SectionLabel>Registry</SectionLabel>
        {registry.isPending ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : registry.isError ? (
          <QueryError error={registry.error} onRetry={() => void registry.refetch()} />
        ) : registry.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">The registry has no extensions yet.</p>
        ) : (
          <Card className="gap-0 py-0">
            <div className="divide-y">
              {registry.data.map((r) => (
                <RegistryRow key={r.name} r={r} checking={update.pending === r.name} onUpdate={() => void update.check(r.name)} />
              ))}
            </div>
          </Card>
        )}
      </section>
    </>
  );
}

function InstalledRow({ e, checking, onUpdate, onRemove }: { e: ExtensionView; checking: boolean; onUpdate: () => void; onRemove: () => void }) {
  const origin = originView(e);
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{e.displayName}</span>
          <span className="text-sm">{e.version}</span>
          <ToneBadge tone={origin.tone}>{origin.label}</ToneBadge>
          <Badge variant="outline">{e.kind}</Badge>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{e.name}</span>
          <span className="font-mono" title={e.commit ?? undefined}>
            {shortCommit(e.commit)}
          </span>
          <span className="max-w-80 truncate" title={e.source}>
            {e.source}
          </span>
          <span>Used by: {usedByLabel(e.usedBy)}</span>
          <span>
            Installed <TimeAgo date={e.installedAt} />
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
        <Button size="sm" variant="outline" disabled={checking} onClick={onUpdate}>
          {checking ? <Spinner /> : <ArrowUpCircleIcon />} Check for update
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${e.displayName}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onUpdate}>
              <ArrowUpCircleIcon /> Check for update
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2Icon /> Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function RegistryRow({ r, checking, onUpdate }: { r: ExtensionRegistryEntryView; checking: boolean; onUpdate: () => void }) {
  const action = registryAction(r);
  const install = useApiMutation({
    mutationFn: () => api<ExtensionView>("/api/extensions", { body: { source: r.name, expectIntegrity: r.integrity } }),
    invalidate: [keys.extensions, keys.extensionRegistry],
    success: (e) => `Installed ${e.displayName} ${e.version}`,
    errorTitle: `Couldn't install ${r.displayName}`,
  });
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{r.displayName}</span>
          <span className="text-sm">{r.version}</span>
          <Badge variant="outline">{r.kind}</Badge>
        </div>
        {r.description && <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{r.description}</p>}
        <div className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
          <span className="font-mono">{r.name}</span>
          <span className="font-mono">{shortCommit(r.commit)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
        {action === "install" && (
          <Button size="sm" disabled={install.isPending} onClick={() => install.mutate()}>
            {install.isPending ? <Spinner /> : <DownloadIcon />} Install
          </Button>
        )}
        {action === "installed" && <ToneBadge tone="good">Installed</ToneBadge>}
        {action === "update" && (
          <Button size="sm" variant="outline" disabled={checking} onClick={onUpdate}>
            {checking ? <Spinner /> : <ArrowUpCircleIcon />} Update to {r.version}
          </Button>
        )}
        {action === "conflict" && <ToneBadge tone="warn">A third-party {r.name} is installed</ToneBadge>}
      </div>
    </div>
  );
}
