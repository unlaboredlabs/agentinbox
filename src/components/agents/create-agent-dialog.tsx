import type { AgentWithKey } from "@shared/types";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AgentCreateForm } from "./agent-create-form";
import { AgentCreated } from "./agent-created";

export function CreateAgentDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<AgentWithKey>();
  const navigate = useNavigate();

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) setTimeout(() => setCreated(undefined), 200);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <PlusIcon /> New agent
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        // Don't lose the one-time key to a stray click outside.
        onInteractOutside={(e) => created && e.preventDefault()}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.agent.name} is ready</DialogTitle>
              <DialogDescription>Save the key, then add agentinbox to your agent with one of the snippets below.</DialogDescription>
            </DialogHeader>
            <AgentCreated res={created} />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  void navigate({ to: "/agents/$agentId", params: { agentId: created.agent.id } });
                }}
              >
                <SlidersHorizontalIcon /> Fine-tune permissions
              </Button>
              <Button onClick={() => onOpenChange(false)}>I've saved the key</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New agent</DialogTitle>
              <DialogDescription>Each agent gets its own API key and its own permissions per mailbox.</DialogDescription>
            </DialogHeader>
            <AgentCreateForm onCreated={setCreated} onCancel={() => onOpenChange(false)} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
