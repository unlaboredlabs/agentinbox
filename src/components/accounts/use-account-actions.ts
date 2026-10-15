import type { Account } from "@shared/types";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys } from "@/lib/queries";

const STALE = [keys.accounts, keys.setupState, keys.overview, keys.agents] as const;
const path = (id: string, action = "") => `/api/accounts/${encodeURIComponent(id)}${action}`;

export function useAccountActions() {
  const resync = useApiMutation({
    mutationFn: (a: Account) => api<Account>(path(a.id, "/resync"), { method: "POST" }),
    invalidate: STALE,
    success: (_, a) => `Resync started for ${a.email}`,
    errorTitle: "Couldn't resync",
  });
  const pause = useApiMutation({
    mutationFn: (a: Account) => api<Account>(path(a.id, "/pause"), { method: "POST" }),
    invalidate: STALE,
    success: (_, a) => `${a.email} paused`,
    errorTitle: "Couldn't pause",
  });
  const resume = useApiMutation({
    mutationFn: (a: Account) => api<Account>(path(a.id, "/resume"), { method: "POST" }),
    invalidate: STALE,
    success: (_, a) => `${a.email} resumed`,
    errorTitle: "Couldn't resume",
  });
  const remove = useApiMutation({
    mutationFn: (a: Account) => api(path(a.id), { method: "DELETE" }),
    invalidate: STALE,
    success: (_, a) => `${a.email} removed`,
    errorTitle: false,
  });
  return { resync, pause, resume, remove };
}
