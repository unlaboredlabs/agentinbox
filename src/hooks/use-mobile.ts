import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";

function subscribe(fn: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", fn);
  return () => mql.removeEventListener("change", fn);
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches);
}
