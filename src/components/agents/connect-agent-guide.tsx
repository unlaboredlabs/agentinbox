import type { AgentTool } from "@shared/agent-api";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellRingIcon, MessageSquareTextIcon, ShieldAlertIcon, ShieldCheckIcon, SparklesIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { CodeBlock, CopyField } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { connectCommands, RECIPES, TOOL_LABEL, TOOLS, transportOf } from "@/lib/cli";
import { queries } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Loud warning for plain-http public URLs that aren't loopback or Tailscale (the CLI needs --insecure there). */
export function InsecureTransportAlert({ publicUrl, className }: { publicUrl: string; className?: string }) {
  if (transportOf(publicUrl) !== "insecure") return null;
  return (
    <Alert variant="destructive" className={className}>
      <ShieldAlertIcon />
      <AlertTitle>These commands include --insecure because {new URL(publicUrl).host} is plain http</AlertTitle>
      <AlertDescription>
        <p>
          The agent's API key and every email event would cross the network unencrypted, readable and changeable by anyone in between. The CLI
          refuses this unless you pass <code className="font-mono">--insecure</code>.
        </p>
        <p className="text-foreground/80">
          Put agentinbox behind https (a reverse proxy or tunnel), or reach it over Tailscale, then update the{" "}
          <Link to="/settings" hash="public-url" className="font-medium underline underline-offset-4">
            public URL
          </Link>
          .
        </p>
      </AlertDescription>
    </Alert>
  );
}

function Step({ n, icon: Icon, title, children }: { n: number; icon: typeof TerminalIcon; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="relative grid grid-cols-[2rem_1fr] gap-x-3 pb-6 last:pb-0">
      <span className="absolute top-8 bottom-1 left-4 w-px bg-border [li:last-child>&]:hidden" aria-hidden />
      <span className="relative flex size-8 items-center justify-center rounded-full border bg-background text-muted-foreground">
        <Icon className="size-4" />
        <span className="sr-only">Step {n}</span>
      </span>
      <div className="min-w-0 space-y-2 pt-1">
        <div className="text-sm font-medium">{title}</div>
        {children}
      </div>
    </li>
  );
}

export function ToolTabs({ value, onChange, className }: { value: AgentTool; onChange: (t: AgentTool) => void; className?: string }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as AgentTool)} className={className}>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <TabsList>
          {TOOLS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {TOOL_LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );
}

/**
 * Device-flow pairing, step by step: run `connect` on the agent's machine, approve the matching
 * code here, then (optionally) keep a listener running that wakes the agent on new mail.
 */
export function ConnectAgentGuide({ className }: { className?: string }) {
  const settings = useQuery(queries.settings());
  const [tool, setTool] = useState<AgentTool>("claude-code");
  const publicUrl = settings.data?.publicUrl ?? window.location.origin;
  const c = connectCommands(publicUrl, tool);
  const label = tool === "other" ? "your agent" : TOOL_LABEL[tool];

  return (
    <div className={cn("space-y-5", className)}>
      {settings.data && !settings.data.pairingEnabled && (
        <Alert>
          <ShieldAlertIcon />
          <AlertTitle>Pairing is turned off</AlertTitle>
          <AlertDescription>
            <p>
              <code className="font-mono">connect</code> will be refused until you turn on{" "}
              <Link to="/settings" hash="pairing" className="font-medium text-foreground underline underline-offset-4">
                Accept pairing requests
              </Link>{" "}
              in Settings. You can still create an agent and copy its key yourself.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-lg border bg-muted/30 p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <SparklesIcon className="size-4 text-chart-1" /> Quickest: let the agent set itself up
        </div>
        <p className="mb-2 text-sm text-muted-foreground">Tell your agent:</p>
        <CopyField value={c.selfSetup} />
        <p className="mt-2 text-xs text-muted-foreground">It reads the skill, runs the commands below and asks you to approve it here.</p>
      </div>

      <div className="space-y-3">
        <div className="text-sm font-medium">Or run it yourself</div>
        <ToolTabs value={tool} onChange={setTool} />
        <InsecureTransportAlert publicUrl={publicUrl} />
        <ol>
          <Step n={1} icon={TerminalIcon} title={`On the machine where ${label} runs`}>
            <CodeBlock code={c.connect} />
            <p className="text-xs text-muted-foreground">
              It prints a code like <span className="font-mono">K7QM-2XPD</span> and waits.
              {tool !== "other" && ` --setup-mcp adds agentinbox to ${label} without ever showing the key.`} The agent is named “
              {tool === "other" ? "Agent" : TOOL_LABEL[tool]} on &lt;hostname&gt;” unless you pass <span className="font-mono">--name</span>.
            </p>
          </Step>
          <Step n={2} icon={ShieldCheckIcon} title="Approve it here">
            <p className="text-sm text-muted-foreground">
              The request appears in{" "}
              <Link to="/approvals" search={{ tab: "access" }} className="font-medium text-foreground underline underline-offset-4">
                Approvals → Agent access
              </Link>
              . Type the code from the terminal to approve it and choose what the agent may do. Its key goes straight to the terminal; you never
              see or paste it.
            </p>
          </Step>
          <Step n={3} icon={BellRingIcon} title={<>Wake it on new mail <span className="font-normal text-muted-foreground">(optional)</span></>}>
            <CodeBlock code={c.listen} />
            <p className="text-xs text-muted-foreground">
              Runs in the background (systemd or launchd) and starts {label} for each new email. {RECIPES[tool].note}
            </p>
          </Step>
        </ol>
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <MessageSquareTextIcon className="mt-px size-3.5 shrink-0" />
        <span>
          Only the agentinbox skill, for an agent you've already set up: <code className="font-mono text-foreground">{c.skillInstall}</code>
        </span>
      </p>
    </div>
  );
}
