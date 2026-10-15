import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ActivityIcon, BotIcon, MailIcon, ShieldAlertIcon, StampIcon, WebhookIcon, WrenchIcon } from "lucide-react";
import { PageHeader, QueryError, StatCard } from "@/components/common";
import { ActivityChart } from "@/components/overview/activity-chart";
import { AccountsAttention, ApprovalsCallout, PairingCallout } from "@/components/overview/attention";
import { RecentEvents } from "@/components/overview/recent-events";
import { SetupChecklist } from "@/components/overview/setup-checklist";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNumber, plural } from "@/lib/format";
import { queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/")({
  component: Overview,
});

function Overview() {
  const stats = useQuery(queries.overview());
  const accounts = useQuery(queries.accounts());
  const pending = useQuery(queries.approvals("pending"));
  const pairings = useQuery(queries.pairings("pending"));
  const s = stats.data;
  const pairingCount = pairings.data?.length ?? 0;
  const waiting = (s?.pendingApprovals ?? 0) + pairingCount;
  const loading = stats.isPending;

  return (
    <>
      <PageHeader title="Overview" description="What your agents and mailboxes have been up to in the last 24 hours." />
      <SetupChecklist />
      <AccountsAttention accounts={accounts.data ?? []} />
      <PairingCallout pairings={pairings.data ?? []} />
      <ApprovalsCallout approvals={pending.data ?? []} />

      {stats.isError ? (
        <QueryError error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard
            label="Accounts"
            icon={MailIcon}
            loading={loading}
            value={s ? (s.accounts.active === s.accounts.total ? fmtNumber(s.accounts.total) : `${s.accounts.active} of ${s.accounts.total}`) : null}
            hint={s && (s.accounts.needsAttention ? <span className="text-critical">{s.accounts.needsAttention === 1 ? "1 needs attention" : `${s.accounts.needsAttention} need attention`}</span> : "all active")}
          />
          <StatCard label="Agents" icon={BotIcon} loading={loading} value={fmtNumber(s?.agents.total)} hint={s && `${s.agents.activeLast24h} active today`} />
          <StatCard label="Mail events" icon={ActivityIcon} loading={loading} value={fmtNumber(s?.events24h)} hint="last 24h" />
          <StatCard
            label="Tool calls"
            icon={WrenchIcon}
            loading={loading}
            value={fmtNumber(s?.toolCalls24h)}
            hint={s && (s.denied24h ? <span className="text-warning">{s.denied24h} blocked by guardrails</span> : "none blocked")}
          />
          <StatCard
            label="Deliveries"
            icon={WebhookIcon}
            loading={loading}
            value={fmtNumber(s?.deliveries24h.succeeded)}
            hint={s && (s.deliveries24h.failed ? <span className="text-critical">{s.deliveries24h.failed} failed</span> : "none failed")}
          />
          <StatCard
            label="Approvals"
            icon={waiting ? StampIcon : ShieldAlertIcon}
            tone={waiting ? "warn" : undefined}
            loading={loading}
            value={fmtNumber(waiting)}
            hint={
              waiting
                ? [s?.pendingApprovals && plural(s.pendingApprovals, "message"), pairingCount && plural(pairingCount, "agent")].filter(Boolean).join(" · ")
                : "nothing waiting"
            }
          />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Mail events and agent tool calls per hour, last 24 hours.</CardDescription>
          </CardHeader>
          <CardContent>{s ? <ActivityChart activity={s.activity} /> : <Skeleton className="h-56" />}</CardContent>
        </Card>
        <RecentEvents />
      </div>
    </>
  );
}
