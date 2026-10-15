import type { Account } from "@shared/types";
import { useQueries } from "@tanstack/react-query";
import { queries } from "@/lib/queries";

/** "CATEGORY_UPDATES" → "Updates", "STARRED" → "Starred". */
export function prettySystemLabel(id: string) {
  if (!/^[A-Z_]+$/.test(id)) return id;
  const s = id.replace(/^CATEGORY_/, "").toLowerCase().replace(/_/g, " ");
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Label id → display name across the given accounts (user labels by name, system labels prettified). */
export function useLabelNames(accounts: Account[]): (id: string) => string {
  const results = useQueries({ queries: accounts.map((a) => ({ ...queries.labels(a.id), enabled: a.status === "active" })) });
  const map = new Map<string, string>();
  for (const r of results) for (const l of r.data ?? []) if (l.type === "user") map.set(l.id, l.name);
  return (id) => map.get(id) ?? prettySystemLabel(id);
}
