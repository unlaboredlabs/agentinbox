import type { AccessLevel } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ArrowRightIcon, GlobeIcon, NetworkIcon, PlugIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChoiceCards } from "@/components/choice-cards";
import { CopyField, ErrorAlert, ExternalLink, QueryError } from "@/components/common";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import {
  type ConnectionView,
  type CreateConnectionResult,
  type PresetView,
  type ProbeInput,
  type ProbeResult,
  type SetupStep,
  queries,
} from "@/lib/queries";
import { connectAccount } from "@/components/accounts/connect-host";
import { connectConnection } from "./connection-auth";
import {
  ACCESS_LEVELS,
  authControl,
  type ConnectionDraft,
  createInput,
  draftProblems,
  emptyDraft,
  hostPort,
  inputProblems,
  LEVEL_INFO,
  privateExplanation,
  probeSummary,
  slugProblem,
  suggestSlug,
} from "./connection-flow";

interface Request {
  /** Open straight on this preset ("notion", "whoop"), or on the custom URL form with "custom". */
  start?: string;
  onDone?: (c: ConnectionView) => void;
}

let opener: ((r: Request) => void) | null = null;

/** Opens "Add connection" (from the Connections page, Overview, or the first-run wizard). */
export function openAddConnection(r: Request = {}) {
  opener?.(r);
}

type Page = "pick" | "setup" | "access";

/** The "Add connection" dialog. Mounted once in the app layout; hands the sign-in to ConnectionAuthHost. */
export function AddConnectionHost() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>("pick");
  const [draft, setDraft] = useState<ConnectionDraft>(emptyDraft());
  const [startWith, setStartWith] = useState<string | undefined>();
  const onDone = useRef<Request["onDone"]>(undefined);
  const presets = useQuery({ ...queries.presets(), enabled: open });
  const connections = useQuery({ ...queries.connections(), enabled: open });
  const taken = (connections.data ?? []).map((c) => c.slug);

  const openerRef = useRef<(r: Request) => void>(() => {});
  useEffect(() => {
    openerRef.current = (r) => {
      onDone.current = r.onDone;
      setDraft(emptyDraft());
      setPage(r.start ? "setup" : "pick");
      setOpen(true);
      if (!r.start || r.start === "custom") return;
      // Opened on a preset id: pick it once the presets are known (the picker if it isn't one).
      setStartWith(r.start);
      void qc
        .fetchQuery(queries.presets())
        .then((list) => {
          const p = list.find((x) => x.id === r.start);
          setDraft(emptyDraft(p ?? null));
          if (!p) setPage("pick");
        })
        .catch(() => setPage("pick"))
        .finally(() => setStartWith(undefined));
    };
  });
  useEffect(() => {
    opener = (r) => openerRef.current(r);
    return () => {
      opener = null;
    };
  }, []);

  const choose = (p: PresetView | null) => {
    // Gmail & Calendar is the native Google integration: its own connect flow (and setup, when Google isn't set up yet).
    if (p?.id === "google") {
      setOpen(false);
      return connectAccount();
    }
    setDraft(emptyDraft(p));
    setPage("setup");
  };

  const set = (patch: Partial<ConnectionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setupProblems = draftProblems(draft, taken).filter((p) => !p.startsWith("Pick at least one agent"));
  const problems = draftProblems(draft, taken);
  const name = draft.displayName.trim() || draft.preset?.displayName || draft.slug || "the server";

  const connect = () => {
    const body = createInput(draft);
    const done = onDone.current;
    setOpen(false);
    connectConnection({
      name,
      run: () => api<CreateConnectionResult>("/api/connections", { body }),
      onDone: done,
    });
  };

  const title = page === "pick" ? "Add a connection" : page === "access" ? `What can agents do with ${name}?` : draft.preset ? `Connect ${draft.preset.displayName}` : "Connect an MCP server";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {page === "pick"
              ? "agentinbox keeps the sign-in. Agents get its tools through their one agentinbox connection, never the credentials."
              : page === "access"
                ? "You can change this later, for all agents or one at a time on an agent's page."
                : draft.preset
                  ? (draft.preset.description ?? `Gives your agents ${draft.preset.displayName}'s tools.`)
                  : "Paste the server's address. agentinbox checks how it signs in."}
          </DialogDescription>
        </DialogHeader>

        {page === "pick" &&
          (presets.isPending ? (
            <Skeleton className="h-48" />
          ) : presets.isError ? (
            <QueryError error={presets.error} onRetry={() => void presets.refetch()} />
          ) : (
            <PresetPicker presets={presets.data} onPick={choose} />
          ))}

        {page === "setup" && (startWith && startWith !== "custom" ? <Skeleton className="h-48" /> : <SetupPage draft={draft} set={set} taken={taken} />)}

        {page === "access" && <AccessPage draft={draft} set={set} />}

        <DialogFooter className="gap-2">
          {page !== "pick" && (
            <Button variant="ghost" onClick={() => setPage(page === "access" ? "setup" : "pick")} className="sm:mr-auto">
              <ArrowLeftIcon /> Back
            </Button>
          )}
          {page === "setup" && (
            <Button disabled={setupProblems.length > 0} onClick={() => setPage("access")} title={setupProblems[0]}>
              Continue <ArrowRightIcon />
            </Button>
          )}
          {page === "access" && (
            <Button disabled={problems.length > 0} onClick={connect} title={problems[0]}>
              <PlugIcon /> Connect {name}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PresetPicker({ presets, onPick }: { presets: PresetView[]; onPick: (p: PresetView | null) => void }) {
  const item = "flex w-full items-start gap-3 rounded-lg border bg-card p-3 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <ul className="space-y-2">
      {presets.map((p) => (
        <li key={p.id}>
          <button type="button" className={item} onClick={() => onPick(p)}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-semibold">{p.displayName.slice(0, 1)}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{p.displayName}</span>
              {p.description && <span className="block text-xs text-muted-foreground">{p.description}</span>}
            </span>
            <ArrowRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
      <li>
        <button type="button" className={item} onClick={() => onPick(null)}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <GlobeIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Another MCP server</span>
            <span className="block text-xs text-muted-foreground">Any remote MCP server, by its address. On this computer or your network works too.</span>
          </span>
          <ArrowRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
        </button>
      </li>
    </ul>
  );
}

function SetupPage({ draft, set, taken }: { draft: ConnectionDraft; set: (p: Partial<ConnectionDraft>) => void; taken: string[] }) {
  const control = draft.preset ? authControl({ preset: draft.preset }) : draft.probe ? authControl({ probe: draft.probe }) : null;
  const slugIssue = draft.slug ? slugProblem(draft.slug, taken) : null;
  const stepIssues = draft.preset ? inputProblems(draft.preset.setupSteps, draft.inputs) : {};
  return (
    <FieldGroup>
      {!draft.preset && <ProbeForm draft={draft} set={set} />}

      {draft.preset?.setupSteps.length ? (
        <ol className="space-y-4">
          {draft.preset.setupSteps.map((s, i) => (
            <SetupStepView
              key={s.id}
              n={i + 1}
              step={s}
              value={s.input ? (draft.inputs[s.input.key] ?? "") : ""}
              problem={s.input && draft.inputs[s.input.key] ? stepIssues[s.input.key] : undefined}
              onChange={(v) => s.input && set({ inputs: { ...draft.inputs, [s.input.key]: v } })}
            />
          ))}
        </ol>
      ) : null}

      {control?.kind === "header" && (
        <Field>
          <FieldLabel htmlFor="conn-header">API key or token</FieldLabel>
          <PasswordInput id="conn-header" autoComplete="off" value={draft.headerValue} onChange={(e) => set({ headerValue: e.target.value })} />
          <FieldDescription>
            Sent as the <code className="font-mono">{control.headerName}</code> header{control.prefix ? ` (with “${control.prefix.trim()}” in front)` : ""}. Stored
            encrypted; agents never see it.
          </FieldDescription>
        </Field>
      )}
      {control?.kind === "oauth" && control.needsClientId && (
        <Field>
          <FieldLabel htmlFor="conn-client">Client ID</FieldLabel>
          <Input id="conn-client" autoComplete="off" value={draft.clientId} onChange={(e) => set({ clientId: e.target.value })} />
          <FieldDescription>Register an app on {control.issuer ? hostPort(control.issuer) : "the sign-in server"} and paste its client ID.</FieldDescription>
        </Field>
      )}
      {control?.kind === "oauth" && !control.needsClientId && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
          After the next page, a window opens to sign in{draft.preset ? ` to ${draft.preset.displayName}` : ""} and approve access.
        </p>
      )}

      {(draft.preset || draft.probe?.kind !== undefined) && draft.probe?.kind !== "private" && (
        <Field>
          <FieldLabel htmlFor="conn-slug">Short name</FieldLabel>
          <Input
            id="conn-slug"
            value={draft.slug}
            maxLength={24}
            onChange={(e) => set({ slug: e.target.value.toLowerCase() })}
            aria-invalid={!!slugIssue}
            className="font-mono"
          />
          {slugIssue ? (
            <FieldError>{slugIssue}</FieldError>
          ) : (
            <FieldDescription>
              Agents see its tools as <code className="font-mono">{draft.slug || "name"}__search</code> and so on.
            </FieldDescription>
          )}
        </Field>
      )}
    </FieldGroup>
  );
}

function ProbeForm({ draft, set }: { draft: ConnectionDraft; set: (p: Partial<ConnectionDraft>) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const probe = async (allowPrivate?: string) => {
    setPending(true);
    setError(undefined);
    try {
      const body: ProbeInput = { url: draft.url.trim(), ...(allowPrivate ? { allowPrivate } : {}) };
      const r = await api<ProbeResult>("/api/connections/probe", { body });
      set({
        probe: r,
        privateTarget: allowPrivate ?? null,
        slug: draft.slug || suggestSlug(r.url),
        displayName: draft.displayName || ("serverName" in r && r.serverName) || "",
      });
    } catch (err) {
      setError(err);
      set({ probe: null });
    } finally {
      setPending(false);
    }
  };
  const p = draft.probe;
  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.url.trim()) void probe();
        }}
      >
        <Field>
          <FieldLabel htmlFor="conn-url">Server address</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="conn-url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://mcp.example.com/mcp"
              value={draft.url}
              onChange={(e) => set({ url: e.target.value, probe: null, privateTarget: null })}
            />
            <Button type="submit" variant="outline" disabled={!draft.url.trim() || pending}>
              {pending ? <Spinner /> : <SearchIcon />} Check
            </Button>
          </div>
          <FieldDescription>The address you'd give an MCP client, usually ending in /mcp.</FieldDescription>
        </Field>
      </form>
      {error !== undefined && <ErrorAlert error={error} />}
      {p && p.kind !== "private" && (
        <Alert variant="success">
          <ShieldCheckIcon />
          <AlertTitle>Found it</AlertTitle>
          <AlertDescription>
            <p>{probeSummary(p)}</p>
            {draft.privateTarget && <p>Allowed on your private network: {hostPort(draft.privateTarget)}.</p>}
          </AlertDescription>
        </Alert>
      )}
      {p?.kind === "private" && (
        <Alert variant="warning">
          <NetworkIcon />
          <AlertTitle>This is on your private network</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{probeSummary(p)}</p>
            <p>{privateExplanation(p.target, p.range)}</p>
            <Button size="sm" disabled={pending} onClick={() => void probe(p.target)}>
              {pending && <Spinner />} Allow {hostPort(p.target)}
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Renders `code` spans; the rest stays plain text. */
function StepBody({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded bg-muted px-1 font-mono text-[0.85em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

/** One preset setup step, rendered generically: title, body, link, copy, input. */
export function SetupStepView({
  n,
  step,
  value,
  problem,
  onChange,
}: {
  n: number;
  step: SetupStep;
  value: string;
  problem?: string;
  onChange: (v: string) => void;
}) {
  const id = `setup-${step.id}`;
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular" aria-hidden>
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <div className="font-medium">{step.title}</div>
        {step.body && (
          <p className="text-muted-foreground">
            <StepBody text={step.body} />
          </p>
        )}
        {step.link && <ExternalLink href={step.link.url}>{step.link.label}</ExternalLink>}
        {step.copy && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{step.copy.label}</div>
            <CopyField value={step.copy.value} label={`Copy ${step.copy.label.toLowerCase()}`} />
          </div>
        )}
        {step.input && (
          <Field>
            <FieldLabel htmlFor={id}>{step.input.label}</FieldLabel>
            {step.input.secret ? (
              <PasswordInput id={id} autoComplete="off" placeholder={step.input.placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!problem} />
            ) : (
              <Input id={id} autoComplete="off" placeholder={step.input.placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!problem} />
            )}
            {problem && <FieldError>{problem}</FieldError>}
          </Field>
        )}
      </div>
    </li>
  );
}

function AccessPage({ draft, set }: { draft: ConnectionDraft; set: (p: Partial<ConnectionDraft>) => void }) {
  return (
    <div className="space-y-5">
      <LevelChoice value={draft.level} onChange={(level) => set({ level })} />
      <AgentPicker value={draft.agents} onChange={(agents) => set({ agents })} />
    </div>
  );
}

/** The one access choice: Full / Ask before risky actions (the default) / Read only. */
export function LevelChoice({ value, onChange }: { value: AccessLevel; onChange: (v: AccessLevel) => void }) {
  return (
    <ChoiceCards
      aria-label="Access level"
      value={value}
      onChange={onChange}
      choices={ACCESS_LEVELS.map((l) => ({
        value: l,
        title: LEVEL_INFO[l].label,
        description: LEVEL_INFO[l].description,
        badge: l === "ask" ? <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">Recommended</span> : undefined,
      }))}
    />
  );
}

/** Which agents get the connection: all (now and later, the default) or some. */
function AgentPicker({ value, onChange }: { value: "all" | string[]; onChange: (v: "all" | string[]) => void }) {
  const agents = useQuery(queries.agents());
  const list = agents.data ?? [];
  const all = value === "all";
  const picked = all ? [] : value;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">Which agents get it</legend>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={all} onCheckedChange={(c) => onChange(c ? "all" : list.map((a) => a.id))} />
        All agents, including ones you add later
      </label>
      {!all && (
        <ul className="space-y-1.5 pl-6">
          {list.map((a) => (
            <li key={a.id}>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={picked.includes(a.id)}
                  onCheckedChange={(c) => onChange(c ? [...picked, a.id] : picked.filter((x) => x !== a.id))}
                />
                {a.name}
              </label>
            </li>
          ))}
          {list.length === 0 && <li className="text-sm text-muted-foreground">No agents yet. Pick “All agents” to give it to the ones you add.</li>}
        </ul>
      )}
    </fieldset>
  );
}
