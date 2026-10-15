import type { PubsubState, PubsubTestResult, Settings } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, KeyRoundIcon, RadioTowerIcon, RefreshCwIcon, SendIcon, TimerIcon, XCircleIcon, ZapIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { connectAccount } from "@/components/accounts/connect-host";
import { CodeBlock, CopyField, ErrorAlert, ExternalLink, linkify, TimeAgo, ToneBadge } from "@/components/common";
import { updateDraft } from "@/components/setup/progress";
import { cloudUrl } from "@/components/setup/step-project";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError, toastError } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";

const PROVISION_STEPS = ["Creating the Pub/Sub topic", "Letting Gmail publish to it", "Creating the subscription", "Starting Gmail watches"];
const GMAIL_PUSH = "serviceAccount:gmail-api-push@system.gserviceaccount.com";

/**
 * Status of real-time delivery, with one-click provisioning, a test, and the polling fallback.
 * `compact` (the wizard): the step offers polling itself, so the panel doesn't repeat that button.
 */
export function PubsubPanel({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const state = useQuery(queries.setupState());
  const accountList = useQuery(queries.accounts());
  const settings = useQuery(queries.settings());
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<unknown>();
  // Set after a Pub/Sub consent: if Google still says the scope is missing, the box wasn't ticked.
  const [grantedFor, setGrantedFor] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<PubsubTestResult>();
  const [switching, setSwitching] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const problemRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    for (const k of [keys.setupState, keys.settings, keys.system, keys.accounts]) void qc.invalidateQueries({ queryKey: k });
  };

  const p = state.data?.pubsub;
  const active = p?.mode === "pubsub" && !!p.subscription;
  const accounts = (accountList.data ?? []).filter((a) => a.status === "active");
  const principalId = chosen ?? p?.principalAccountId ?? accounts[0]?.id;
  const principal = accountList.data?.find((a) => a.id === principalId);
  const projectId = state.data?.gcpProjectId ?? "";

  const provision = async (accountId = principalId) => {
    setProvisioning(true);
    setProvisionError(undefined);
    setTest(undefined);
    try {
      await api<PubsubState>("/api/google/pubsub/provision", { method: "POST", body: accountId ? { accountId } : {} });
      updateDraft({ pubsubSkipped: false });
      setGrantedFor(null);
      toast.success("New mail now arrives within seconds", { description: "Send a test to confirm." });
      refresh();
    } catch (err) {
      setProvisionError(err);
      refresh();
    } finally {
      setProvisioning(false);
    }
  };

  // A new problem (or the permission panel) appears below the button: take focus there so it's noticed.
  useEffect(() => {
    if (provisionError !== undefined) requestAnimationFrame(() => problemRef.current?.focus());
  }, [provisionError]);

  const sendTest = async () => {
    setTesting(true);
    try {
      setTest(await api<PubsubTestResult>("/api/google/pubsub/test", { method: "POST" }));
      refresh();
    } catch (err) {
      toastError(err, "Test failed");
    } finally {
      setTesting(false);
    }
  };

  const usePolling = async () => {
    setSwitching(true);
    try {
      await api<Settings>("/api/settings", { method: "PATCH", body: { ingestMode: "poll" } });
      updateDraft({ pubsubSkipped: true });
      setProvisionError(undefined);
      refresh();
    } catch (err) {
      toastError(err, "Couldn't switch to polling");
    } finally {
      setSwitching(false);
    }
  };

  const grant = () => {
    const who = principal;
    connectAccount({
      scopes: ["pubsub"],
      reauthAccountId: who?.id,
      email: who?.email,
      onDone: () => {
        setGrantedFor(who?.email ?? "");
        void provision(who?.id);
      },
    });
  };

  if (state.isPending) return <Skeleton className="h-32 rounded-xl" />;
  const code = provisionError instanceof ApiError ? provisionError.code : undefined;
  const pollingMode = settings.data?.ingestMode !== "pubsub";

  const accountPicker = accounts.length > 1 && (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Set up with</span>
      <Select value={principalId} onValueChange={(v) => setChosen(v)}>
        <SelectTrigger size="sm" className="min-w-56" aria-label="Account that sets up Pub/Sub">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
        <span className={cn("flex size-9 items-center justify-center rounded-lg", active ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
          {active ? <ZapIcon className="size-4" /> : <TimerIcon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {active ? "Real-time (Pub/Sub)" : "Polling"}
            {active ? <ToneBadge tone="good">Active</ToneBadge> : <ToneBadge tone="idle">Every {settings.data?.pollIntervalSeconds ?? "…"}s</ToneBadge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {active ? (
              <>
                Set up with {p?.principalEmail ?? "a connected account"}. Last message <TimeAgo date={p?.lastMessageAt} fallback="none yet" />
              </>
            ) : (
              `New mail shows up within ${settings.data?.pollIntervalSeconds ?? 30} seconds.`
            )}
          </p>
        </div>
      </div>

      {p && (p.topic || p.subscription) && !compact && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Topic</dt>
          <dd className="font-mono break-all">{p.topic ?? "—"}</dd>
          <dt className="text-muted-foreground">Subscription</dt>
          <dd className="font-mono break-all">{p.subscription ?? "—"}</dd>
        </dl>
      )}

      {p?.lastError && provisionError === undefined && !pollingMode && <ErrorAlert error={new Error(p.lastError)} title="Pub/Sub reported a problem" />}

      {provisioning && <ProvisionProgress />}

      <div ref={problemRef} tabIndex={-1} className="space-y-3 outline-none" role={provisionError !== undefined ? "alert" : undefined}>
        {code === "pubsub_scope_required" && (
          <Panel
            icon={<KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-warning" />}
            title={grantedFor !== null ? "The Pub/Sub box wasn't ticked" : "One more permission: Pub/Sub"}
          >
            <p>
              {grantedFor !== null
                ? "Google didn't give agentinbox Pub/Sub access. Click Grant again and tick the Pub/Sub box on Google's screen."
                : (
                  <>
                    Connecting Gmail only asked for mail access. To create its notification channel, agentinbox also needs Pub/Sub access from{" "}
                    <span className="font-medium text-foreground">{principal?.email ?? "the account it sets up with"}</span>. You'll see a Google
                    window once.
                  </>
                )}
            </p>
            {accountPicker}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={grant}>
                <KeyRoundIcon /> Grant Pub/Sub access
              </Button>
              <Button size="sm" variant="outline" onClick={() => void provision()} disabled={provisioning}>
                <RefreshCwIcon /> Try again
              </Button>
            </div>
          </Panel>
        )}

        {code === "pubsub_permission_denied" && (
          <Panel icon={<KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-warning" />} title={`${principal?.email ?? "This account"} can't manage Pub/Sub in ${projectId || "the project"}`}>
            <p>
              It needs the Owner or Pub/Sub Admin role on the project (whoever created the project is Owner already). Either set up with an account
              that has it, or give this one the role: in IAM, click <strong className="text-foreground">Grant access</strong>, paste the account,
              choose the role, and Save.
            </p>
            {accountPicker}
            {principal && <CopyField value={principal.email} label="Copy account email" />}
            <CopyField value="roles/pubsub.admin" label="Copy role" />
            <div className="flex flex-wrap items-center gap-3">
              {projectId && <ExternalLink href={cloudUrl.iam(projectId)}>Open IAM in Google Cloud</ExternalLink>}
            </div>
            {principal && projectId && (
              <>
                <p>Or run this in Cloud Shell as the project owner:</p>
                <CodeBlock
                  code={`gcloud projects add-iam-policy-binding ${projectId} --member=user:${principal.email} --role=roles/pubsub.admin`}
                  wrap
                  copyLabel="Copy gcloud command"
                />
              </>
            )}
            <Button size="sm" onClick={() => void provision()} disabled={provisioning}>
              <RefreshCwIcon /> Try again
            </Button>
          </Panel>
        )}

        {code === "pubsub_org_policy" && (
          <Panel icon={<XCircleIcon className="mt-0.5 size-4 shrink-0 text-critical" />} title="Your organization's policy blocks Gmail notifications">
            <p>
              A Google Workspace rule (Domain Restricted Sharing) stops Gmail's notification service from publishing into your project. Polling
              works without it. To use real-time anyway, an admin with the Organization Policy Administrator role edits the policy{" "}
              <span className="font-mono text-xs">iam.allowedPolicyMemberDomains</span> for this project (Manage policy → Override parent's policy →
              add a rule that allows all values, or allows this principal), then you try again:
            </p>
            <CopyField value={GMAIL_PUSH} label="Copy Gmail push principal" />
            {projectId && <ExternalLink href={cloudUrl.orgPolicies(projectId)}>Open Organization policies</ExternalLink>}
            <p className="text-xs">Creating the project outside your organization also avoids it, but then the app can't be Internal.</p>
          </Panel>
        )}

        {provisionError !== undefined && code !== "pubsub_scope_required" && code !== "pubsub_permission_denied" && code !== "pubsub_org_policy" && (
          <ErrorAlert error={provisionError} title="Couldn't turn on real-time delivery">
            {code === "pubsub_billing" && projectId && (
              <p className="pt-1">
                <ExternalLink href={cloudUrl.billing(projectId)}>Link a billing account</ExternalLink>
              </p>
            )}
            {(code === "needs_reauth" || code === "account_paused") && principal && (
              <div className="pt-2">
                <Button size="sm" variant="outline" onClick={() => connectAccount({ reauthAccountId: principal.id, email: principal.email })}>
                  Reconnect {principal.email}
                </Button>
              </div>
            )}
            {accountPicker && <div className="pt-2">{accountPicker}</div>}
            <p className="pt-1 text-foreground/80">Polling works fine too; it's just slower to notice new mail.</p>
          </ErrorAlert>
        )}
      </div>

      {test && (
        <div className={cn("flex items-start gap-2 rounded-lg border p-3 text-sm", test.ok ? "border-success/30 bg-success/5" : "border-critical/30 bg-critical/5")} role="status">
          {test.ok ? <CheckCircle2Icon className="mt-0.5 size-4 text-success" /> : <XCircleIcon className="mt-0.5 size-4 text-critical" />}
          <span>{linkify(test.message)}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {provisionError === undefined && (
          <Button onClick={() => void provision()} disabled={provisioning || accounts.length === 0} variant={active ? "outline" : "default"}>
            {provisioning ? <Spinner /> : <RadioTowerIcon />} {active ? "Set up again" : "Set up real-time automatically"}
          </Button>
        )}
        {provisionError !== undefined && code !== "pubsub_scope_required" && code !== "pubsub_permission_denied" && (
          <Button variant="outline" onClick={() => void provision()} disabled={provisioning}>
            <RefreshCwIcon /> Try again
          </Button>
        )}
        {active && (
          <Button variant="outline" onClick={sendTest} disabled={testing}>
            {testing ? <Spinner /> : <SendIcon />} Send test
          </Button>
        )}
        {!compact &&
          (settings.data?.ingestMode === "pubsub" ? (
            <Button variant="ghost" onClick={usePolling} disabled={switching}>
              Switch to polling
            </Button>
          ) : (
            provisionError !== undefined && (
              <Button variant="ghost" onClick={usePolling} disabled={switching}>
                Use polling instead
              </Button>
            )
          ))}
        {provisionError === undefined && !active && accounts.length > 1 && accountPicker}
      </div>
      {accounts.length === 0 && <p className="text-xs text-muted-foreground">Connect a Gmail account first: setting this up uses its Google access.</p>}
    </div>
  );
}

function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/[0.06] p-3 text-sm">
      <div className="flex items-start gap-2">
        {icon}
        <div className="min-w-0 flex-1 space-y-2 text-muted-foreground">
          <div className="font-medium text-foreground">{title}</div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Provisioning is one request; this walks through what it does while you wait (timing is approximate). */
function ProvisionProgress() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => Math.min(s + 1, PROVISION_STEPS.length - 1)), 1200);
    return () => clearInterval(id);
  }, []);
  return (
    <ol className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm" aria-live="polite">
      {PROVISION_STEPS.map((s, i) => (
        <li key={s} className={cn("flex items-center gap-2", i > step && "text-muted-foreground/60", i < step && "text-muted-foreground")}>
          {i < step ? (
            <span className="mx-[3px] size-2 rounded-full bg-muted-foreground/60" />
          ) : i === step ? (
            <Spinner className="size-3.5" />
          ) : (
            <span className="mx-[3px] size-2 rounded-full border" />
          )}
          {s}
        </li>
      ))}
    </ol>
  );
}
