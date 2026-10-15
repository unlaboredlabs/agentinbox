import type { AgentWithKey } from "@shared/types";
import { SectionLabel } from "@/components/common";
import { ConnectSnippets } from "./connect-snippets";
import { KeyReveal } from "./key-reveal";

/** Shown right after creating an agent (or rotating its key): the key once, plus ready-to-paste setup. */
export function AgentCreated({ res }: { res: AgentWithKey }) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel>API key for {res.agent.name}</SectionLabel>
        <KeyReveal apiKey={res.apiKey} />
      </div>
      <div className="space-y-2">
        <SectionLabel>Connect your agent</SectionLabel>
        <ConnectSnippets apiKey={res.apiKey} />
      </div>
    </div>
  );
}
