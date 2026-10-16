import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { QueryError, TimeAgo, ToneBadge } from "@/components/common";
import { openAddConnection } from "@/components/connections/add-connection";
import { AGENT_LEVELS, connectionStatusView, grantsWith, LEVEL_INFO } from "@/components/connections/connection-flow";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import type { ApprovalRule, ConnectionGrant } from "@shared/types";
import type { AgentConnection, AgentLevel } from "@/lib/broker-dto";
import { keys, queries } from "@/lib/queries";
import { escapeInvisible } from "@/components/approvals/mcp-call";

/** The agent's level on each connection (Full / Ask / Read only / No access) and its "Always allowed" rules. */
export function AgentConnections({ agentId }: { agentId: string }) {
  const list = useQuery(queries.agentConnections(agentId));
  const rules = useQuery(queries.approvalRules(agentId));
  return (
    <section className="space-y-3" aria-labelledby="connections-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="connections-heading" className="text-lg font-semibold tracking-tight">
            Connections
          </h2>
          <p className="text-sm text-muted-foreground">What this agent may do with each connection. xaq enforces it on every call.</p>
        </div>
      </div>
      {list.isPending ? (
        <Skeleton className="h-20 rounded-xl" />
      ) : list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">No connections yet. Add Notion, WHOOP, T3 Code or any MCP server for your agents.</p>
            <Button variant="outline" onClick={() => openAddConnection()}>
              <PlusIcon /> Add connection
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y">
            {list.data.map((c) => (
              <ConnectionLevelRow key={c.connectionId} agentId={agentId} c={c} />
            ))}
          </ul>
        </Card>
      )}

      <div className="space-y-2 pt-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <CheckCheckIcon className="size-4 text-muted-foreground" /> Always allowed
        </h3>
        <p className="text-sm text-muted-foreground">Calls you chose “Always allow this” for. They run without asking. Remove one to be asked again.</p>
        {rules.isPending ? (
          <Skeleton className="h-12 rounded-xl" />
        ) : rules.isError ? (
          <QueryError error={rules.error} onRetry={() => void rules.refetch()} />
        ) : rules.data.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Nothing yet.</p>
        ) : (
          <Card className="gap-0 py-0">
            <ul className="divide-y">
              {rules.data.map((r) => (
                <RuleRow key={r.id} r={r} connectionName={list.data?.find((c) => c.connectionId === r.connectionId)?.name ?? "a connection"} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </section>
  );
}

function ConnectionLevelRow({ agentId, c }: { agentId: string; c: AgentConnection }) {
  const now = useNow(60_000);
  const status = connectionStatusView({ ...c, statusReason: null, expiresAt: null }, now);
  const set = useApiMutation({
    // The API takes a connection's full grant list: read it fresh, change this agent's entry, put it back.
    mutationFn: async (level: AgentLevel) => {
      const base = `/api/connections/${encodeURIComponent(c.connectionId)}/grants`;
      const grants = await api<ConnectionGrant[]>(base);
      return api<ConnectionGrant[]>(base, { method: "PUT", body: grantsWith(grants, agentId, level) });
    },
    // No access deletes the agent's "always allow" rules on it (the policy does): refresh that list too.
    invalidate: [keys.agentConnections(agentId), keys.connections, keys.approvalRules],
    success: (_, level) => `${c.name}: ${LEVEL_INFO[level].label.toLowerCase()}`,
    errorTitle: "Couldn't change the access",
  });
  return (
    <li className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/connections/$connectionId" params={{ connectionId: c.connectionId }} className="font-medium hover:underline">
            {c.name}
          </Link>
          {c.status !== "active" && <ToneBadge tone={status.tone}>{status.label}</ToneBadge>}
        </div>
        <p className="text-xs text-muted-foreground">{LEVEL_INFO[c.level].description}</p>
      </div>
      <Select value={c.level} onValueChange={(v) => set.mutate(v as AgentLevel)} disabled={set.isPending}>
        <SelectTrigger className="w-full sm:w-60" aria-label={`Access to ${c.name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGENT_LEVELS.map((l) => (
            <SelectItem key={l} value={l}>
              {LEVEL_INFO[l].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </li>
  );
}

function RuleRow({ r, connectionName }: { r: ApprovalRule; connectionName: string }) {
  const remove = useApiMutation({
    mutationFn: () => api(`/api/approval-rules/${encodeURIComponent(r.id)}`, { method: "DELETE" }),
    invalidate: [keys.approvalRules],
    success: "Removed. It asks again next time.",
    errorTitle: "Couldn't remove the rule",
  });
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 text-sm">
        <div className="break-all">
          <span className="font-mono font-medium">{escapeInvisible(r.tool, true)}</span> <span className="text-muted-foreground">on {connectionName}</span>
        </div>
        <div className="text-xs break-all text-muted-foreground">
          {r.targetPath ? (
            <>
              Only for <span className="font-mono">{escapeInvisible(r.targetPath, true)}</span> = <span className="font-mono text-foreground">{escapeInvisible(r.targetValue ?? "", true)}</span>
            </>
          ) : (
            "Any target"
          )}{" "}
          · added <TimeAgo date={r.createdAt} />
        </div>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove the rule for ${r.tool}`} disabled={remove.isPending} onClick={() => remove.mutate()}>
        <Trash2Icon />
      </Button>
    </li>
  );
}
