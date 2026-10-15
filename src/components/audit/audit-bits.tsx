import type { AuditEntry } from "@shared/types";
import { BotIcon, CpuIcon, UserIcon } from "lucide-react";
import { ToneBadge } from "@/components/common";
import { AUDIT_OUTCOME, DENIAL_REASONS } from "@/lib/labels";

export function OutcomeBadge({ outcome }: { outcome: AuditEntry["outcome"] }) {
  const o = AUDIT_OUTCOME[outcome];
  return <ToneBadge tone={o.tone}>{o.label}</ToneBadge>;
}

export function Actor({ entry: e }: { entry: AuditEntry }) {
  const Icon = e.actorType === "agent" ? BotIcon : e.actorType === "admin" ? UserIcon : CpuIcon;
  const name = e.actorName ?? (e.actorType === "admin" ? "Admin" : e.actorType === "system" ? "System" : (e.actorId ?? "Unknown agent"));
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Denial reason in plain language, highlighted. */
export function DenialReason({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-warning/15 px-1.5 py-0.5 text-xs">
      <code className="font-mono">{reason}</code>
      {DENIAL_REASONS[reason] && <span className="text-muted-foreground">{DENIAL_REASONS[reason]}</span>}
    </span>
  );
}

export function ActionName({ action }: { action: string }) {
  return <code className="font-mono text-[13px]">{action}</code>;
}
