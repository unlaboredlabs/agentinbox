import { useState, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { toastError } from "@/lib/api";

interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** May be async: the dialog stays open while pending, and stays open (with a toast) if it throws. */
  onConfirm: () => Promise<unknown> | unknown;
}

let current: ConfirmOptions | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Opens a confirmation dialog. */
export function confirm(opts: ConfirmOptions) {
  current = opts;
  emit();
}

export function ConfirmHost() {
  const opts = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
  const [pending, setPending] = useState(false);
  const close = () => {
    current = null;
    emit();
  };

  return (
    <AlertDialog open={!!opts} onOpenChange={(open) => !open && !pending && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
          {opts?.description && <AlertDialogDescription asChild><div className="space-y-2">{opts.description}</div></AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={opts?.destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={async (e) => {
              e.preventDefault();
              setPending(true);
              try {
                await opts?.onConfirm();
                close();
              } catch (err) {
                toastError(err);
              } finally {
                setPending(false);
              }
            }}
          >
            {pending && <Spinner />}
            {opts?.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
