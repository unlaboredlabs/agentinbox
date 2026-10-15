import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SecretReveal } from "./secret-reveal";

export function SecretDialog({ secret, title, description, onClose }: { secret: string | undefined; title: string; description: string; onClose: () => void }) {
  return (
    // One-time secret: only the explicit button closes it (no Escape, outside click or X).
    <Dialog open={!!secret}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {secret && <SecretReveal secret={secret} />}
        <DialogFooter>
          <Button onClick={onClose}>I've saved the secret</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
