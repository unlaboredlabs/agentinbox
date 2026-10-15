import type { AgentWithKey } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BotIcon, PartyPopperIcon } from "lucide-react";
import { useState } from "react";
import { AgentCreateForm } from "@/components/agents/agent-create-form";
import { AgentCreated } from "@/components/agents/agent-created";
import { TestConnection } from "@/components/agents/test-connection";
import { Button } from "@/components/ui/button";
import { queries } from "@/lib/queries";
import type { StepProps } from "./step-url";
import { StepCard, StepFooter } from "./wizard-shell";

export function StepAgent({ index, onBack, onNext }: StepProps) {
  const agents = useQuery(queries.agents());
  const [created, setCreated] = useState<AgentWithKey>();
  const existing = agents.data ?? [];
  const [creatingAnother, setCreatingAnother] = useState(false);
  const showForm = !created && (existing.length === 0 || creatingAnother);

  return (
    <StepCard
      index={index}
      title={created ? `${created.agent.name} is ready` : "Create your first agent"}
      description={
        created
          ? "Save its key, add agentinbox to your agent with a snippet, and test the connection."
          : "An agent is anything that talks MCP: Claude Code, Codex, Cursor, your own app. It gets its own key and only the access you grant. Sending starts as drafts for you to review."
      }
      footer={
        <StepFooter
          onBack={onBack}
          onNext={onNext}
          nextLabel="Finish setup"
          nextDisabled={showForm && existing.length === 0}
          hint={created ? "Make sure you've saved the key" : undefined}
        />
      }
    >
      {created ? (
        <>
          <AgentCreated res={created} />
          <TestConnection agentId={created.agent.id} />
        </>
      ) : showForm ? (
        <AgentCreateForm defaultName={existing.length ? "" : "My first agent"} onCreated={setCreated} onCancel={creatingAnother ? () => setCreatingAnother(false) : undefined} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border p-4">
            <PartyPopperIcon className="mt-0.5 size-5 shrink-0 text-chart-1" />
            <div className="space-y-1 text-sm">
              <div className="font-medium">
                You have {existing.length} agent{existing.length === 1 ? "" : "s"} already
              </div>
              <p className="text-muted-foreground">Fine-tune permissions, connect snippets and webhooks from each agent's page.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {existing.slice(0, 4).map((a) => (
              <Button key={a.id} variant="outline" size="sm" asChild>
                <Link to="/agents/$agentId" params={{ agentId: a.id }}>
                  <BotIcon /> {a.name}
                </Link>
              </Button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setCreatingAnother(true)}>
              Create another
            </Button>
          </div>
        </div>
      )}
    </StepCard>
  );
}
