import type { ExtensionResolveResult, ExtensionUpdateResult, ExtensionView } from "@shared/extensions";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ToneBadge } from "@/components/common";
import { confirm } from "@/components/confirm";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError, describeError, toastError } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys } from "@/lib/queries";
import { originView, shortCommit, updateRows } from "./extension-logic";

const invalidate = [keys.extensions, keys.extensionRegistry] as const;
const path = (name: string, rest = "") => `/api/extensions/${encodeURIComponent(name)}${rest}`;

/** Name, version, kind, origin, source, commit, integrity and declared hosts of an extension (or a candidate). */
export function ExtensionFacts({ e }: { e: ExtensionView }) {
  const origin = originView(e);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{e.displayName}</span>
        <span className="font-mono text-xs text-muted-foreground">{e.name}</span>
        <span>{e.version}</span>
        <ToneBadge tone={origin.tone}>{origin.label}</ToneBadge>
        <ToneBadge tone="idle">{e.kind}</ToneBadge>
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Source</dt>
        <dd className="break-all">{e.source}</dd>
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="font-mono">{shortCommit(e.commit)}</dd>
        <dt className="text-muted-foreground">Integrity</dt>
        <dd className="break-all font-mono">{e.integrity}</dd>
        {e.kind === "code" && (
          <>
            <dt className="text-muted-foreground">Network</dt>
            <dd>{e.network.length ? e.network.join(", ") : "none declared"}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <Alert variant="warning">
      <AlertTriangleIcon />
      <AlertTitle>Third-party extension</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** Adds from a GitHub URL, a git URL, a directory on xaq's machine, or a registry name: review first, then install. */
export function AddExtensionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [source, setSource] = useState("");
  const [review, setReview] = useState<ExtensionResolveResult | null>(null);
  const close = () => {
    onOpenChange(false);
    setReview(null);
    setSource("");
  };
  const resolve = useApiMutation({
    mutationFn: (s: string) => api<ExtensionResolveResult>("/api/extensions/resolve", { body: { source: s } }),
    errorTitle: "Couldn't fetch the extension",
    onSuccess: (r) => setReview(r),
  });
  const install = useApiMutation({
    mutationFn: (r: ExtensionResolveResult) =>
      api<ExtensionView>("/api/extensions", { body: { source: source.trim(), confirmThirdParty: !r.candidate.official, expectIntegrity: r.candidate.integrity } }),
    invalidate,
    success: (e) => `Installed ${e.displayName} ${e.version}`,
    errorTitle: "Couldn't install it",
    onSuccess: close,
  });
  const c = review?.candidate;
  const blocked = !!review?.installed && review.installed.integrity !== c?.integrity;
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an extension</DialogTitle>
          <DialogDescription>From a GitHub URL, another git URL, or a directory on xaq's machine. You see what it is before anything is installed.</DialogDescription>
        </DialogHeader>
        {!review ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (source.trim()) resolve.mutate(source.trim());
            }}
          >
            <Field>
              <FieldLabel htmlFor="ext-source">Source</FieldLabel>
              <Input id="ext-source" autoFocus autoComplete="off" placeholder="https://github.com/owner/repo/tree/main/extensions/name" value={source} onChange={(e) => setSource(e.target.value)} />
              <FieldDescription>
                Other git URLs take <code className="font-mono">#ref</code> or <code className="font-mono">#ref:path</code>.
              </FieldDescription>
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={!source.trim() || resolve.isPending}>
                {resolve.isPending && <Spinner />} Review
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <ExtensionFacts e={c!} />
            <Warnings warnings={review.warnings} />
            {review.installed && (
              <p className="text-sm text-muted-foreground">
                {blocked
                  ? `${c!.name} is already installed (${review.installed.version}). Update it from the list instead.`
                  : `${c!.name} ${review.installed.version} is already installed.`}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setReview(null)}>
                Back
              </Button>
              {!review.installed && (
                <Button variant={c!.official ? "default" : "destructive"} disabled={install.isPending} onClick={() => install.mutate(review)}>
                  {install.isPending && <Spinner />} {c!.official ? "Install" : "I trust it: install"}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Checks for an update and, when there is one, shows old and new before installing it on confirmation. */
export function useUpdateExtension() {
  const [pending, setPending] = useState<string | null>(null);
  const [preview, setPreview] = useState<NonNullable<ExtensionUpdateResult["update"]> | null>(null);
  const check = async (name: string) => {
    setPending(name);
    try {
      const r = await api<ExtensionUpdateResult>(path(name, "/update"), { body: {} });
      if (!r.update) toast.success(`${name} is up to date`);
      else setPreview(r.update);
    } catch (err) {
      toastError(err, "Couldn't check for an update");
    } finally {
      setPending(null);
    }
  };
  const apply = useApiMutation({
    mutationFn: (u: NonNullable<ExtensionUpdateResult["update"]>) => api<ExtensionUpdateResult>(path(u.from.name, "/update"), { body: { confirm: true, expectIntegrity: u.to.integrity } }),
    invalidate,
    success: (r) => (r.update ? `Updated ${r.update.to.displayName} to ${r.update.to.version}` : "Already up to date"),
    errorTitle: "Couldn't update it",
    onSuccess: () => setPreview(null),
  });
  const dialog = (
    <Dialog open={!!preview} onOpenChange={(o) => !o && !apply.isPending && setPreview(null)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update {preview?.from.displayName}?</DialogTitle>
          <DialogDescription>Nothing changes until you confirm.{preview?.from.usedBy.length ? ` ${preview.from.usedBy.join(", ")} switch to the new version.` : ""}</DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="space-y-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-normal" />
                  <th className="py-1 pr-2 font-normal">Installed</th>
                  <th className="py-1 font-normal">New</th>
                </tr>
              </thead>
              <tbody>
                {updateRows(preview.from, preview.to).map((r) => (
                  <tr key={r.label} className="align-top">
                    <td className="py-1 pr-2 text-muted-foreground">{r.label}</td>
                    <td className="break-all py-1 pr-2 font-mono">{r.from}</td>
                    <td className={`break-all py-1 font-mono ${r.changed ? "font-semibold" : "text-muted-foreground"}`}>{r.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Warnings warnings={preview.warnings} />
            <DialogFooter>
              <Button variant="ghost" disabled={apply.isPending} onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button disabled={apply.isPending} onClick={() => apply.mutate(preview)}>
                {apply.isPending && <Spinner />} Update to {preview.to.version}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
  return { check, pending, dialog };
}

/** Remove: refused while connections use it; then offers to force it, which disables them. */
export function useRemoveExtension() {
  const qc = useQueryClient();
  const remove = async (e: ExtensionView, force: boolean) => {
    await api(path(e.name, force ? "?force=true" : ""), { method: "DELETE" });
    for (const key of [...invalidate, keys.connections]) void qc.invalidateQueries({ queryKey: key });
    toast.success(`Removed ${e.displayName}`);
  };
  const askForce = (e: ExtensionView, why: string) =>
    confirm({
      title: `${e.displayName} is in use`,
      destructive: true,
      confirmLabel: "Disable them and remove",
      description: (
        <>
          <p>{why}</p>
          <p>Removing it anyway disables those connections. Their credentials stay until you remove the connections.</p>
        </>
      ),
      onConfirm: () => remove(e, true),
    });
  return (e: ExtensionView) => {
    if (e.usedBy.length) return askForce(e, `Used by ${e.usedBy.join(", ")}.`);
    confirm({
      title: `Remove ${e.displayName}?`,
      destructive: true,
      confirmLabel: "Remove",
      description: <p>Its files are deleted. You can add it again later.</p>,
      onConfirm: async () => {
        try {
          await remove(e, false);
        } catch (err) {
          // A connection started using it since the list loaded.
          if (err instanceof ApiError && err.code === "in_use") return askForce(e, describeError(err).message);
          throw err;
        }
      },
    });
  };
}
