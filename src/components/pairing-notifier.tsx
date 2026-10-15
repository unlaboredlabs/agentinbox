import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useRef } from "react";
import { toast } from "sonner";
import { useStreamListener } from "@/lib/stream";

/** Toasts once per new pairing request, unless the approvals page is already open. */
export function PairingNotifier() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const seen = useRef(new Set<string>());
  useStreamListener((msg) => {
    if (msg.kind !== "pairing" || msg.data.status !== "pending" || seen.current.has(msg.data.id)) return;
    seen.current.add(msg.data.id);
    if (pathname.startsWith("/approvals")) return;
    toast(`${msg.data.name} is asking for access`, {
      description: msg.data.client.hostname ? `From ${msg.data.client.hostname}. Approve it with the code in its terminal.` : "Approve it with the code in its terminal.",
      duration: 15_000,
      action: { label: "Review", onClick: () => void navigate({ to: "/approvals", search: { tab: "access" } }) },
    });
  });
  return null;
}
