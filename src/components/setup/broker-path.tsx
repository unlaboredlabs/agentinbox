import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CalendarIcon, GlobeIcon, NotebookIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { ChoiceCards } from "@/components/choice-cards";
import { openAddConnection } from "@/components/connections/add-connection";
import { ConnectionRow } from "@/components/connections/connection-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { queries } from "@/lib/queries";
import { FIRST_CHOICE_INFO, FIRST_CHOICES, type FirstChoice } from "./first-run";
import { updateDraft } from "./progress";
import { StepCard, StepFooter } from "./wizard-shell";

const ICONS: Record<FirstChoice, React.ComponentType<{ className?: string }>> = {
  notion: NotebookIcon,
  custom: GlobeIcon,
  google: CalendarIcon,
};

/** First run's first question: what to connect. Gmail & Calendar enters the Google steps; the rest take the short path. */
export function StepChoose({ onChosen }: { onChosen: (c: FirstChoice) => void }) {
  const [choice, setChoice] = useState<FirstChoice | undefined>();
  return (
    <Card className="gap-0 py-0">
      <div className="space-y-1.5 border-b p-5 sm:p-6">
        <h2 className="text-xl font-semibold tracking-tight">What do you want to connect first?</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">You can add the others any time. Only Gmail & Calendar needs a Google Cloud project.</p>
      </div>
      <CardContent className="p-5 sm:p-6">
        <ChoiceCards
          aria-label="What to connect first"
          value={choice}
          onChange={setChoice}
          columns={2}
          choices={FIRST_CHOICES.map((c) => ({ value: c, title: FIRST_CHOICE_INFO[c].title, description: FIRST_CHOICE_INFO[c].description, icon: ICONS[c] }))}
        />
      </CardContent>
      <div className="flex justify-end border-t bg-muted/20 p-4 sm:px-6">
        <Button
          disabled={!choice}
          onClick={() => {
            if (!choice) return;
            updateDraft({ firstConnect: choice });
            onChosen(choice);
          }}
        >
          Continue <ArrowRightIcon />
        </Button>
      </div>
    </Card>
  );
}

/** Short path, step 1: Add connection for the chosen integration (or a custom server). */
export function StepFirstConnection({ choice, onNext }: { choice: Exclude<FirstChoice, "google">; onNext: () => void }) {
  const list = useQuery(queries.connections());
  const has = (list.data?.length ?? 0) > 0;
  const info = FIRST_CHOICE_INFO[choice];
  const add = () => openAddConnection({ start: info.presetId ?? "custom", onDone: () => onNext() });
  return (
    <StepCard
      index={0}
      total={2}
      title={choice === "custom" ? "Add your MCP server" : `Connect ${info.title}`}
      description="xaq keeps the sign-in. You choose what agents may do with it; risky actions ask you first by default."
      footer={
        <StepFooter
          onNext={onNext}
          nextDisabled={!has}
          nextVariant={has ? "default" : "outline"}
          hint={!has ? "Add a connection to continue" : undefined}
          extra={
            <Button variant="ghost" onClick={() => updateDraft({ firstConnect: undefined })}>
              Connect something else
            </Button>
          }
        />
      }
    >
      {has ? (
        <div className="space-y-3">
          <div className="divide-y rounded-lg border">
            {list.data!.map((c) => (
              <ConnectionRow key={c.id} connection={c} />
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => openAddConnection()}>
            <PlusIcon /> Add another
          </Button>
        </div>
      ) : (
        <Button size="lg" onClick={add}>
          <PlusIcon /> {choice === "custom" ? "Add a server" : `Connect ${info.title}`}
        </Button>
      )}
    </StepCard>
  );
}
