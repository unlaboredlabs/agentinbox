import type { ConsoleStreamMessage } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { keys } from "./queries";

export type StreamState = "connecting" | "open" | "reconnecting" | "offline";
type Listener = (msg: ConsoleStreamMessage) => void;

interface StreamContextValue {
  state: StreamState;
  subscribe: (fn: Listener) => () => void;
}

const StreamContext = createContext<StreamContextValue>({ state: "connecting", subscribe: () => () => {} });

/** Which cached queries each kind of stream message makes stale. */
const STALE: Record<ConsoleStreamMessage["kind"], readonly (readonly string[])[]> = {
  event: [keys.events, keys.overview],
  delivery: [keys.deliveries, keys.webhooks, keys.overview],
  approval: [keys.approvals, keys.overview],
  audit: [keys.audit, keys.agents, keys.overview],
  account: [keys.accounts, keys.setupState, keys.overview],
  // Approving a pairing creates an agent.
  pairing: [keys.agents, keys.overview],
};
const ALL_STALE = [...new Set(Object.values(STALE).flat())];

function isMessage(v: unknown): v is ConsoleStreamMessage {
  return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && "data" in v;
}

/**
 * Holds the console's single EventSource on /api/events/stream. Each message refreshes the queries
 * it affects (batched) and is handed to subscribers (the live events page, the OAuth connect flow).
 * EventSource retries dropped connections itself; when the server refuses outright (CLOSED), we retry
 * with backoff. After any reconnect, everything stream-fed is refetched since messages may have been missed.
 */
export function StreamProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<StreamState>("connecting");
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let everOpened = false;
    let disposed = false;
    const pending = new Map<string, readonly string[]>();

    const invalidate = (roots: readonly (readonly string[])[]) => {
      for (const r of roots) pending.set(r.join("/"), r);
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        for (const key of pending.values()) void qc.invalidateQueries({ queryKey: key });
        pending.clear();
      }, 300);
    };

    const connect = () => {
      if (disposed) return;
      es?.close();
      es = new EventSource("/api/events/stream", { withCredentials: true });
      es.onopen = () => {
        if (everOpened) invalidate(ALL_STALE);
        everOpened = true;
        attempt = 0;
        setState("open");
      };
      es.onmessage = (e: MessageEvent<string>) => {
        let msg: unknown;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!isMessage(msg)) return;
        invalidate(STALE[msg.kind] ?? []);
        for (const l of listeners.current) l(msg);
      };
      es.onerror = () => {
        if (!es || es.readyState !== EventSource.CLOSED) {
          setState("reconnecting");
          return;
        }
        es.close();
        setState(everOpened ? "reconnecting" : "offline");
        const delay = Math.min(30_000, 1000 * 2 ** attempt++);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, delay);
      };
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && (!es || es.readyState === EventSource.CLOSED)) {
        clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(retryTimer);
      clearTimeout(flushTimer);
      es?.close();
    };
  }, [qc]);

  const [subscribe] = useState(() => (fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  });

  return <StreamContext value={{ state, subscribe }}>{children}</StreamContext>;
}

export const useStreamState = () => useContext(StreamContext).state;

/** Calls `fn` for every stream message while mounted. `fn` may change between renders. */
export function useStreamListener(fn: Listener) {
  const { subscribe } = useContext(StreamContext);
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe]);
}
