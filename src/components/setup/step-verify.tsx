import type { AgentTool } from "@shared/agent-api";
import type { Account, Agent, MailEvent, Page, TestEmailResult } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2Icon, CircleIcon, MailIcon, PartyPopperIcon, SendIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useAgentOrigin, useMcpActivity } from "@/components/agents/agent-status";
import { Command } from "@/components/agents/command";
import { toolName, usePublicUrl } from "@/components/agents/connect-agent-guide";
import { grantInWords } from "@/components/agents/grant-words";
import { CopyButton, ErrorAlert, TimeAgo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, apiGet } from "@/lib/api";
import { connectCommands, LISTEN_TEST_EXEC, NPX, shellQuote } from "@/lib/cli";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { updateDraft } from "./progress";
import type { StepProps } from "./step-url";
import { StepCard, StepFooter } from "./wizard-shell";

// ───────────── State shared with step 7 (per browser and instance) ─────────────

interface VerifyState {
  /** The agent being checked (set when step 7 approves or creates one). */
  agentId?: string;
  /** "I'll use MCP only": no listener expected. */
  skipListen?: boolean;
  test?: TestEmailResult & { accountId: string };
}

const KEY = `agentinbox.verify:${typeof window === "undefined" ? "" : window.location.host}`;
const subs = new Set<() => void>();
let cache: VerifyState | null = null;

function readState(): VerifyState {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as VerifyState;
  } catch {
    cache = {};
  }
  return cache;
}

function writeState(patch: Partial<VerifyState>) {
  cache = { ...readState(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode: keep in memory */
  }
  for (const s of subs) s();
}

/** Step 7 calls this when an agent is approved (or created with a key), so this step checks that one. */
export function setVerifyAgent(agentId: string) {
  writeState({ agentId, skipListen: undefined, test: undefined });
}

function useVerifyState() {
  return useSyncExternalStore((l) => (subs.add(l), () => subs.delete(l)), readState);
}

/** True once `on` has been true (a tick never goes back while the step is open). */
function useLatch(on: boolean) {
  const [latched, setLatched] = useState(on);
  if (on && !latched) setLatched(true);
  return latched || on;
}

// ───────────── Step ─────────────

/** Read-type tools: the agent reading the test email over MCP. */
const READ_TOOLS = new Set(["search_threads", "get_thread", "get_message", "list_events", "wait_for_events"]);
const TEST_SUBJECT = "agentinbox test: your setup works";

export function StepVerify({ index, onBack, onNext }: StepProps) {
  // Listener state and lastUsedAt aren't on the console stream: poll while this step is open.
  const agents = useQuery({ ...queries.agents(), refetchInterval: 3000 });
  const state = useVerifyState();
  const list = agents.data ?? [];
  const agent = list.find((a) => a.id === state.agentId) ?? [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const finish = () => {
    updateDraft({ verified: true } as never);
    onNext();
  };

  return (
    <StepCard
      index={index}
      title="Check that it works"
      description="Each line turns green on its own as your agent connects. Then send a test email and watch it arrive."
      footer={<VerifyFooter agent={agent} state={state} onBack={onBack} onFinish={finish} />}
    >
      {agents.isPending ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : agents.isError ? (
        <ErrorAlert error={agents.error} title="Couldn't load your agents" />
      ) : !agent ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No agent yet. Go back one step, run <code className="font-mono text-foreground">connect</code> and approve the request.
        </div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="verify-agent" className="text-muted-foreground">
                Checking
              </label>
              <Select value={agent.id} onValueChange={(id) => setVerifyAgent(id)}>
                <SelectTrigger id="verify-agent" className="w-auto min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {list.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Checklist key={agent.id} agent={agent} state={state} />
        </>
      )}
    </StepCard>
  );
}

// The footer needs the same "complete" answer as the checklist; the checklist reports it here.
const completeSubs = new Set<() => void>();
let completeFor: string | null = null;
function setComplete(agentId: string | null) {
  if (completeFor === agentId) return;
  completeFor = agentId;
  for (const s of completeSubs) s();
}
const useComplete = () => useSyncExternalStore((l) => (completeSubs.add(l), () => completeSubs.delete(l)), () => completeFor);

function VerifyFooter({ agent, onBack, onFinish }: { agent: Agent | undefined; state: VerifyState; onBack?: () => void; onFinish: () => void }) {
  const complete = useComplete() === agent?.id && !!agent;
  return (
    <StepFooter
      onBack={onBack}
      onNext={onFinish}
      nextLabel="Finish setup"
      nextDisabled={!complete}
      hint={complete ? undefined : "Finish turns on when every check is green"}
      extra={
        !complete && (
          <Button variant="ghost" onClick={onFinish}>
            Finish without checking
          </Button>
        )
      }
    />
  );
}

type ItemState = "done" | "current" | "todo" | "skipped";

function Item({
  state,
  title,
  detail,
  children,
  optional,
}: {
  state: ItemState;
  title: React.ReactNode;
  detail?: React.ReactNode;
  children?: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <li className="relative grid grid-cols-[1.5rem_1fr] gap-x-3 pb-5 last:pb-0">
      <span className="absolute top-7 bottom-0 left-3 w-px bg-border [li:last-child>&]:hidden" aria-hidden />
      <span className="relative flex size-6 items-center justify-center bg-card">
        {state === "done" ? (
          <CheckCircle2Icon className="size-5 text-success" />
        ) : state === "current" ? (
          <Spinner className="size-5 text-chart-1" />
        ) : (
          <CircleIcon className={cn("size-5", state === "skipped" ? "text-muted-foreground/40" : "text-muted-foreground")} />
        )}
      </span>
      <div className="min-w-0 space-y-2 pt-0.5">
        <div className="text-sm">
          <span className={cn("font-medium", (state === "todo" || state === "skipped") && "text-muted-foreground")}>{title}</span>
          <span className="sr-only"> ({state === "current" ? "waiting" : state === "todo" ? "not yet" : state})</span>
          {optional && state !== "done" && <span className="text-muted-foreground"> (optional)</span>}
        </div>
        {detail && <div className="text-sm text-muted-foreground">{detail}</div>}
        {children && <div className="space-y-2">{children}</div>}
      </div>
    </li>
  );
}

function Prompt({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-center gap-1 rounded-md border bg-background py-1 pr-1 pl-3">
      <p className="min-w-0 flex-1 text-sm break-words text-foreground">“{text}”</p>
      <CopyButton value={text} label={`Copy ${label}`} />
    </div>
  );
}

function Checklist({ agent, state }: { agent: Agent; state: VerifyState }) {
  const origin = useAgentOrigin(agent);
  const { publicUrl } = usePublicUrl();
  const tool: AgentTool = origin.tool ?? "other";
  const label = origin.tool ? toolName(origin.tool) : agent.name;
  const Label = label[0]!.toUpperCase() + label.slice(1);
  const c = connectCommands(publicUrl, tool);
  const mcp = useMcpActivity(agent, { since: agent.createdAt });
  const test = state.test;

  // Paired agents keep their key in a profile on their machine; only those can run `listen`.
  const canListen = origin.paired;
  const skipListen = !!state.skipListen || (origin.known && !canListen);

  const events = useQuery({
    queryKey: [...keys.events, "verify", test?.accountId ?? ""],
    queryFn: () => apiGet<Page<MailEvent>>("/api/events", { accountId: test!.accountId }),
    enabled: !!test,
    refetchInterval: 5000,
  });
  const ofTest = (events.data?.items ?? []).filter((e) => test && (e.message?.id === test.messageId || (e.message?.subject === TEST_SUBJECT && e.createdAt >= test.sentAt)));
  const received = ofTest.find((e) => e.type === "message.received") ?? ofTest[0];
  const listener = agent.listeners.find((l) => l.connected) ?? agent.listeners[0];

  const mcpDone = useLatch(!!mcp.seenAt);
  const listenDone = useLatch(agent.listeners.some((l) => l.connected));
  const sent = !!test;
  const receivedDone = !!received;
  const delivered = !!received && agent.listeners.some((l) => l.ackedSeq >= received.seq);
  const readIt = !!test && mcp.calls.some((e) => READ_TOOLS.has(e.action) && e.ts >= test.sentAt);
  const complete = mcpDone && (listenDone || skipListen) && sent && receivedDone && (delivered || skipListen);

  useEffect(() => {
    setComplete(complete ? agent.id : null);
    return () => setComplete(null);
  }, [complete, agent.id]);

  // Announce each tick once, politely; move focus to the success heading when everything is green.
  const [announcement, setAnnouncement] = useState("");
  const prev = useRef({ mcpDone, listenDone, receivedDone, delivered, readIt });
  useEffect(() => {
    const p = prev.current;
    const msg =
      (!p.mcpDone && mcpDone && `${Label} called agentinbox.`) ||
      (!p.listenDone && listenDone && "The listener is connected.") ||
      (!p.receivedDone && receivedDone && "The test email arrived.") ||
      (!p.delivered && delivered && "The listener handled the test email.") ||
      (!p.readIt && readIt && `${Label} read your mail.`) ||
      "";
    prev.current = { mcpDone, listenDone, receivedDone, delivered, readIt };
    if (msg) setAnnouncement(msg);
  }, [mcpDone, listenDone, receivedDone, delivered, readIt, Label]);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const wasComplete = useRef(complete);
  useEffect(() => {
    if (complete && !wasComplete.current) doneRef.current?.focus();
    wasComplete.current = complete;
  }, [complete]);

  // The first unfinished item is the one we're waiting on.
  const order: [string, boolean][] = [
    ["mcp", mcpDone],
    ["listen", listenDone || skipListen],
    ["send", sent],
    ["received", receivedDone],
    ["delivered", delivered || skipListen],
  ];
  const current = order.find(([, d]) => !d)?.[0];
  const st = (id: string, done: boolean, skipped = false): ItemState => (done ? "done" : skipped ? "skipped" : id === current ? "current" : "todo");

  return (
    <div className="space-y-6">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {complete && <SuccessPanel agent={agent} label={label} tool={tool} listening={!skipListen} readIt={readIt} headingRef={doneRef} serviceCmd={c.listenService} />}

      <ol aria-label="Setup checks">
        <Item
          state="done"
          title={`${agent.name} is approved`}
          detail={agent.grants.length ? agent.grants.map((g) => grantInWords(g)).join(" · ") : "It has no mailbox access yet: add some on its page."}
        />

        <Item
          state={st("mcp", mcpDone)}
          title={mcpDone ? `${Label} is connected to agentinbox` : `Waiting for ${label} to call agentinbox`}
          detail={
            mcpDone ? (
              mcp.lastToolCall ? (
                <>
                  Last tool call <TimeAgo date={mcp.lastToolCall.ts} /> ({mcp.lastToolCall.action}).
                </>
              ) : (
                <>
                  Connected <TimeAgo date={mcp.connectedAt} />.
                </>
              )
            ) : undefined
          }
        >
          {!mcpDone && <McpHelp tool={tool} label={label} paired={origin.paired} c={c} agentId={agent.id} publicUrl={publicUrl} />}
        </Item>

        <Item
          state={st("listen", listenDone, skipListen)}
          title={
            listenDone
              ? `Listener connected${listener?.client.hostname ? ` on ${listener.client.hostname}` : ""}`
              : skipListen
                ? "No listener: MCP only"
                : "Start the listener so new mail wakes your agent"
          }
          detail={
            skipListen && !listenDone ? (
              canListen ? (
                <>
                  Your agent checks mail when you ask it.{" "}
                  <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => writeState({ skipListen: false })}>
                    Use a listener after all
                  </button>
                </>
              ) : (
                "Agents created with a copied key can't run a listener. Use a webhook from the agent's page instead."
              )
            ) : listenDone ? (
              "It keeps a connection open and runs your command for each new email."
            ) : undefined
          }
        >
          {!listenDone && !skipListen && (
            <>
              <p className="text-sm text-muted-foreground">On the machine where you ran connect (Ctrl-C stops it):</p>
              <Command code={c.listenTry} label="listen command" />
              <p className="text-xs text-muted-foreground">
                {tool === "other"
                  ? "This test command only confirms each email (a ✓ line per email); it starts nothing."
                  : (
                    <>
                      Starts {label} for each new email, with only the agentinbox tools. Just testing delivery?{" "}
                      <code className="font-mono whitespace-nowrap text-foreground">--exec {shellQuote(LISTEN_TEST_EXEC)}</code> only confirms each email.
                    </>
                  )}
              </p>
              <Button variant="outline" size="sm" onClick={() => writeState({ skipListen: true })}>
                I'll use MCP only
              </Button>
            </>
          )}
        </Item>

        <Item
          state={st("send", sent)}
          title={sent ? "Test email sent" : "Send a test email"}
          detail={
            sent ? (
              <>
                From {test.accountId && <AccountEmail id={test.accountId} />} to itself, <TimeAgo date={test.sentAt} />.
              </>
            ) : (
              <>
                agentinbox sends <span className="text-foreground">“{TEST_SUBJECT}”</span> from your Gmail account to itself. Nobody else gets it.
              </>
            )
          }
        >
          <SendTest agent={agent} sent={sent} />
        </Item>

        <Item
          state={st("received", receivedDone)}
          title={receivedDone ? "agentinbox saw it arrive" : current === "received" ? "Waiting for the test email to arrive" : "agentinbox sees it arrive"}
          detail={
            receivedDone ? (
              <>
                New mail event <TimeAgo date={received.createdAt} />.{" "}
                <Link to="/events" className="font-medium text-foreground underline underline-offset-4">
                  See it in Live events
                </Link>
              </>
            ) : sent ? (
              "Usually a few seconds; with polling (no real-time delivery) up to the poll interval."
            ) : undefined
          }
        />

        <Item
          state={st("delivered", delivered, skipListen)}
          title={
            delivered
              ? "Your listener handled it"
              : skipListen
                ? "Delivery to a listener: skipped"
                : current === "delivered"
                  ? "Waiting for your listener to handle it"
                  : "Your listener handles it"
          }
          detail={
            delivered
              ? "Its terminal shows a ✓ line for the email."
              : !skipListen && receivedDone
                ? listenDone
                  ? "Look for a ✓ line in the listener's terminal. If it shows an error, the command failed and is retried."
                  : "Start the listener above: it picks up the email when it connects."
                : undefined
          }
        />

        <Item state={readIt ? "done" : "todo"} optional title={readIt ? `${Label} read your mail` : `Ask ${label} to read it`}>
          {!readIt && receivedDone && <Prompt text="Use agentinbox to summarize my latest email." label="prompt" />}
        </Item>
      </ol>
    </div>
  );
}

function AccountEmail({ id }: { id: string }) {
  const accounts = useQuery(queries.accounts());
  return <span className="text-foreground">{accounts.data?.find((a) => a.id === id)?.email ?? "your account"}</span>;
}

function McpHelp({
  tool,
  label,
  paired,
  c,
  agentId,
  publicUrl,
}: {
  tool: AgentTool;
  label: string;
  paired: boolean;
  c: ReturnType<typeof connectCommands>;
  agentId: string;
  publicUrl: string;
}) {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      {paired && tool !== "other" ? (
        <>
          <p>
            If you ran connect with <span className="font-mono">--setup-mcp</span>, restart {label}. If not, run this on the same machine, then restart{" "}
            {label}:
          </p>
          <Command code={c.setupMcp} label="setup-mcp command" />
          {c.mcpCheck && (
            <p>
              To check: <code className="font-mono text-foreground">{c.mcpCheck}</code> should list agentinbox.
            </p>
          )}
        </>
      ) : paired ? (
        <p>
          Point your agent's MCP client at <code className="font-mono text-foreground">{publicUrl}/mcp</code> with the header{" "}
          <code className="font-mono text-foreground">Authorization: Bearer &lt;key&gt;</code>. The key is the "apiKey" field in{" "}
          <code className="font-mono text-foreground">~/.config/agentinbox/profiles/default.json</code> on the machine where you ran connect.
        </p>
      ) : (
        <p>
          Add agentinbox to your agent with the snippet from the previous step, or from{" "}
          <Link to="/agents/$agentId" params={{ agentId }} className="font-medium text-foreground underline underline-offset-4">
            the agent's page
          </Link>
          .
        </p>
      )}
      <p>Then ask {label}:</p>
      <Prompt text="Use agentinbox to list my email accounts." label="prompt" />
      <p>Also teach it the rules once, with the agentinbox skill:</p>
      <Command code={c.skillInstall} label="skill install command" />
    </div>
  );
}

function SendTest({ agent, sent }: { agent: Agent; sent: boolean }) {
  const accounts = useQuery(queries.accounts());
  const all = (accounts.data ?? []).filter((a) => a.status !== "paused");
  // Prefer mailboxes this agent can read: only those events reach it.
  const readable = all.filter((a) => agent.grants.some((g) => g.accountId === a.id && g.capabilities.includes("read")));
  const choices = readable.length ? readable : all;
  const [picked, setPicked] = useState<string>();
  const accountId = picked && choices.some((a) => a.id === picked) ? picked : choices[0]?.id;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const selectId = useId();

  const send = async () => {
    if (!accountId) return;
    setPending(true);
    setError(null);
    try {
      const res = await api<TestEmailResult>(`/api/accounts/${encodeURIComponent(accountId)}/test-email`, { method: "POST" });
      writeState({ test: { ...res, accountId } });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  if (accounts.isPending) return <Skeleton className="h-9 w-48" />;
  if (!all.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No active Gmail account.{" "}
        <Link to="/accounts" className="font-medium text-foreground underline underline-offset-4">
          Connect or resume one
        </Link>{" "}
        first.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {choices.length > 1 && (
          <>
            <label htmlFor={selectId} className="sr-only">
              Account to send from
            </label>
            <Select value={accountId} onValueChange={setPicked}>
              <SelectTrigger id={selectId} className="w-auto min-w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((a: Account) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Button variant={sent ? "outline" : "default"} onClick={() => void send()} disabled={pending || !accountId}>
          {pending ? <Spinner /> : sent ? <MailIcon /> : <SendIcon />}
          {sent ? "Send another" : "Send a test email"}
        </Button>
      </div>
      {!readable.length && (
        <p className="text-xs text-warning">This agent can't read any connected account yet, so the email won't reach it. Add access on its page.</p>
      )}
      {error != null && <ErrorAlert error={error} title="Couldn't send the test email" />}
    </div>
  );
}

function SuccessPanel({
  agent,
  label,
  tool,
  listening,
  readIt,
  headingRef,
  serviceCmd,
}: {
  agent: Agent;
  label: string;
  tool: AgentTool;
  listening: boolean;
  readIt: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  serviceCmd: string;
}) {
  const system = useQuery(queries.system());
  const latest = useQuery({ ...queries.systemLatest(), enabled: system.data?.service === false });
  // The daemon itself in a terminal: closing it stops everything. UpdateInfo.command carries this instance's flags.
  const daemonCmd = latest.data?.command.replace(/^(.*?agentinbox-cli)(?= |$)/, "$1 service install") ?? `${NPX} service install`;
  return (
    <section aria-labelledby="verify-done" className="space-y-4 rounded-xl border border-success/40 bg-success/5 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <PartyPopperIcon className="mt-0.5 size-5 shrink-0 text-success" />
        <div className="space-y-1">
          <h3 id="verify-done" ref={headingRef} tabIndex={-1} className="font-semibold outline-none">
            Setup complete
          </h3>
          <p className="text-sm text-muted-foreground">
            New mail reaches {agent.name}
            {listening ? " the moment it arrives" : " whenever you ask it"}.
          </p>
        </div>
      </div>
      <ul className="space-y-3 text-sm">
        {listening && (
          <li className="space-y-1.5">
            <p>
              <span className="font-medium">Keep the listener running</span>{" "}
              <span className="text-muted-foreground">after you close its terminal (starts at login):</span>
            </p>
            <Command code={serviceCmd} label="listener service command" />
            <p className="text-xs text-muted-foreground">
              {tool === "other" ? "Replace /path/to/handle-email.sh with your script. " : ""}Stop the one in your terminal first (Ctrl-C).
            </p>
          </li>
        )}
        {system.data?.service === false && (
          <li className="space-y-1.5">
            <p>
              <span className="font-medium">Keep agentinbox itself running.</span>{" "}
              <span className="text-muted-foreground">It runs in a terminal now: closing that stops everything. On this server, run:</span>
            </p>
            <Command code={daemonCmd} label="agentinbox service command" />
          </li>
        )}
        {!readIt && (
          <li className="text-muted-foreground">
            Try it: ask {label} to <span className="text-foreground">“use agentinbox to summarize my latest email.”</span>
          </li>
        )}
        <li className="text-muted-foreground">
          Change what it may do on{" "}
          <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="font-medium text-foreground underline underline-offset-4">
            its page
          </Link>
          ; sends that need your OK and new agents asking for access wait in{" "}
          <Link to="/approvals" className="font-medium text-foreground underline underline-offset-4">
            Approvals
          </Link>
          .
        </li>
      </ul>
    </section>
  );
}
