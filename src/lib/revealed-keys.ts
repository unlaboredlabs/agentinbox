import { useSyncExternalStore } from "react";

/**
 * Agent API keys are shown once (at creation or rotation). We keep them in memory for this tab only,
 * so the connect snippets on the agent page can include the real key until the page is reloaded.
 * Never persisted.
 */
const keysByAgent = new Map<string, string>();
const listeners = new Set<() => void>();

export function rememberKey(agentId: string, key: string) {
  keysByAgent.set(agentId, key);
  listeners.forEach((l) => l());
}

export function forgetKey(agentId: string) {
  keysByAgent.delete(agentId);
  listeners.forEach((l) => l());
}

export function useRevealedKey(agentId: string): string | undefined {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => keysByAgent.get(agentId),
  );
}

/** Drops every remembered key (sign-out, expired session). */
export function forgetAllKeys() {
  keysByAgent.clear();
  listeners.forEach((l) => l());
}
