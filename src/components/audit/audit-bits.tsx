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
  const name =
    e.actorType === "admin" ? "Admin" : e.actorType === "system" ? (e.actorName ?? "System") : (e.actorName ?? e.actorId ?? "Unknown agent");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Denial reason in plain language, highlighted. */
export function DenialReason({ reason, action }: { reason: string | null; action?: string }) {
  if (!reason) return null;
  const text = action?.startsWith("pairing.") && reason === "rate_limit" ? "Too many requests from this address" : DENIAL_REASONS[reason];
  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 rounded-md bg-warning/15 px-1.5 py-0.5 text-xs">
      <code className="font-mono break-all">{reason}</code>
      {text && <span className="min-w-0 break-words text-muted-foreground">{text}</span>}
    </span>
  );
}

export function ActionName({ action }: { action: string }) {
  return <code className="font-mono text-[13px]">{action}</code>;
}
