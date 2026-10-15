import type { PubsubState, PubsubTestResult, Settings } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, KeyRoundIcon, RadioTowerIcon, RefreshCwIcon, SendIcon, TimerIcon, XCircleIcon, ZapIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert, TimeAgo, ToneBadge } from "@/components/common";
import { updateDraft } from "@/components/setup/progress";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { connectAccount } from "@/components/accounts/connect-host";
import { api, ApiError, toastError } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";

const PROVISION_STEPS = ["Creating the Pub/Sub topic", "Letting Gmail publish to it", "Creating the subscription", "Starting Gmail watches"];

/** Status of real-time delivery, with one-click provisioning, a test, and the polling fallback. */
export function PubsubPanel({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const state = useQuery(queries.setupState());
  const accountList = useQuery(queries.accounts());
  const settings = useQuery(queries.settings());
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<unknown>();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<PubsubTestResult>();
  const [switching, setSwitching] = useState(false);

  const refresh = () => {
    for (const k of [keys.setupState, keys.settings, keys.system, keys.accounts]) void qc.invalidateQueries({ queryKey: k });
  };

  const provision = async () => {
    setProvisioning(true);
    setProvisionError(undefined);
    setTest(undefined);
    try {
      await api<PubsubState>("/api/google/pubsub/provision", { method: "POST" });
      updateDraft({ pubsubSkipped: false });
      toast.success("Real-time delivery is on", { description: "Gmail now pushes changes through Pub/Sub. Send a test to confirm." });
      refresh();
    } catch (err) {
      setProvisionError(err);
    } finally {
      setProvisioning(false);
    }
  };

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
      toast.success("Using polling", {
        description: `agentinbox checks for new mail every ${settings.data?.pollIntervalSeconds ?? 30} seconds. You can change this in Settings.`,
      });
      refresh();
    } catch (err) {
      toastError(err, "Couldn't switch to polling");
    } finally {
      setSwitching(false);
    }
  };

  const needsScope =
    provisionError instanceof ApiError &&
    (provisionError.code === "pubsub_scope_required" || /access to (cloud )?pub\/?sub|manage pub\/?sub|pub\/?sub (access|scope|permission)/i.test(`${provisionError.message} ${provisionError.hint ?? ""}`));

  // The account agentinbox provisions with, when the server's error names it; otherwise the server picks.
  const principal = (() => {
    const text = provisionError instanceof ApiError ? `${provisionError.message} ${provisionError.hint ?? ""}` : "";
    const named = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)?.map((e) => e.toLowerCase().replace(/\.$/, "")) ?? [];
    return (accountList.data ?? []).find((a) => named.includes(a.email.toLowerCase()));
  })();
  const projectId = state.data?.gcpProjectId;

  if (state.isPending) return <Skeleton className="h-32 rounded-xl" />;
  const p = state.data?.pubsub;
  const accounts = state.data?.accountsConnected ?? 0;
  const active = p?.mode === "pubsub" && !!p.subscription;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
        <span className={cn("flex size-9 items-center justify-center rounded-lg", active ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
          {active ? <ZapIcon className="size-4" /> : <TimerIcon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {active ? "Real-time (Pub/Sub push)" : "Polling"}
            {active ? <ToneBadge tone="good">Active</ToneBadge> : <ToneBadge tone="idle">Every {settings.data?.pollIntervalSeconds ?? "…"}s</ToneBadge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {active ? (
              <>
                Last Pub/Sub message <TimeAgo date={p.lastMessageAt} fallback="none yet" />
              </>
            ) : (
              "New mail shows up within one poll interval."
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

      {p?.lastError && !provisionError && <ErrorAlert error={new Error(p.lastError)} title="Pub/Sub reported a problem" />}

      {provisioning && <ProvisionProgress />}

      {needsScope && (
        <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/[0.06] p-3 text-sm">
          <div className="flex items-start gap-2">
            <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="space-y-1">
              <div className="font-medium">One more permission: Pub/Sub</div>
              <p className="text-muted-foreground">
                Connecting Gmail only asks for mail access. To create the topic and subscription, agentinbox also needs Pub/Sub access from{" "}
                {principal ? <span className="font-medium text-foreground">{principal.email}</span> : "the account it provisions with"}, which must be
                an Owner or Pub/Sub Admin of {projectId ? <span className="font-mono text-foreground">{projectId}</span> : "the Google Cloud project"}.
              </p>
              <p className="text-muted-foreground">
                Not the project owner? Ask the owner to grant this account the Pub/Sub Admin role in Google Cloud (IAM), or connect the owner's
                Gmail account first so agentinbox provisions with it.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => connectAccount({ scopes: ["pubsub"], reauthAccountId: principal?.id, email: principal?.email, onDone: () => void provision() })}>
              <KeyRoundIcon /> Grant Pub/Sub access
            </Button>
            <Button size="sm" variant="outline" onClick={provision} disabled={provisioning}>
              <RefreshCwIcon /> Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={usePolling} disabled={switching}>
              Use polling instead
            </Button>
          </div>
        </div>
      )}

      {provisionError !== undefined && !needsScope && (
        <ErrorAlert error={provisionError} title="Couldn't set up Pub/Sub">
          <p className="pt-1 text-foreground/80">
            Polling works fine for most setups; it's just slower to notice new mail. You can retry Pub/Sub any time from Settings.
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" onClick={usePolling} disabled={switching}>
              {switching ? <Spinner /> : <TimerIcon />} Use polling instead
            </Button>
            <Button size="sm" variant="outline" onClick={provision} disabled={provisioning}>
              <RefreshCwIcon /> Try again
            </Button>
          </div>
        </ErrorAlert>
      )}

      {test && (
        <div className={cn("flex items-start gap-2 rounded-lg border p-3 text-sm", test.ok ? "border-success/30 bg-success/5" : "border-critical/30 bg-critical/5")}>
          {test.ok ? <CheckCircle2Icon className="mt-0.5 size-4 text-success" /> : <XCircleIcon className="mt-0.5 size-4 text-critical" />}
          <span>{test.message}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {provisionError === undefined && (
        <Button onClick={provision} disabled={provisioning || accounts === 0} variant={active ? "outline" : "default"}>
          {provisioning ? <Spinner /> : <RadioTowerIcon />} {active ? "Re-provision Pub/Sub" : "Set up Pub/Sub automatically"}
        </Button>
        )}
        {active && (
          <Button variant="outline" onClick={sendTest} disabled={testing}>
            {testing ? <Spinner /> : <SendIcon />} Send test
          </Button>
        )}
        {settings.data?.ingestMode === "pubsub" ? (
          <Button variant="ghost" onClick={usePolling} disabled={switching}>
            Switch to polling
          </Button>
        ) : (
          !provisionError &&
          !active && (
            <Button variant="ghost" onClick={usePolling} disabled={switching}>
              Keep polling
            </Button>
          )
        )}
      </div>
      {accounts === 0 && <p className="text-xs text-muted-foreground">Connect a Gmail account first: provisioning uses its Google access.</p>}
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
