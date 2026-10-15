import { useSyncExternalStore } from "react";

// One shared ticking clock so every relative timestamp on the page updates together.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  listeners.add(fn);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of listeners) l();
  }, 1000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current time in ms, re-rendering every second (or every `stepMs`, rounded so renders are skipped in between). */
export function useNow(stepMs = 1000) {
  return useSyncExternalStore(subscribe, () => Math.floor(now / stepMs) * stepMs);
}
