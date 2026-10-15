// Pure (relative imports only, no React): verify-checks and the server/test typecheck load it too.

import type { ListenerInfo, MailEvent } from "../../../shared/types.ts";

/**
 * True when this listener received event `e` and acknowledged it after running its command: the
 * event is of a type its stream asked for (unknown types, from older cursors, count), past where its
 * cursor started (older mail predates it; null = unknown, counted), and at or below what it acked.
 * Events of other types are acknowledged too, but without running anything.
 */
export const listenerHandled = (l: ListenerInfo, e: Pick<MailEvent, "seq" | "type">): boolean =>
  (!l.types || l.types.includes(e.type)) && e.seq > (l.startSeq ?? 0) && e.seq <= l.ackedSeq;
