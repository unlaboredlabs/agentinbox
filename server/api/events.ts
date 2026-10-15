import { streamSSE } from "hono/streaming";
import { type ConsoleStreamMessage, EVENT_TYPES, type EventType } from "../../shared/types.ts";
import type { BusEvents } from "../bus.ts";
import type { AppContext } from "../context.ts";
import { badRequest } from "../util/errors.ts";
import { cursorParam } from "../events/repo.ts";
import { router } from "./util.ts";

const HEARTBEAT_MS = 20_000;
/** A client this far behind has stalled; drop it rather than buffer without bound. It reconnects. */
const MAX_PENDING_WRITES = 1000;

/** Bus channel → stream message kind. */
const CHANNELS = ["event", "delivery", "approval", "audit", "account"] as const satisfies (keyof BusEvents & ConsoleStreamMessage["kind"])[];

/** Paths are relative to /api. */
export function eventsApi(ctx: AppContext, opts: { heartbeatMs?: number; maxPendingWrites?: number } = {}) {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const maxPending = opts.maxPendingWrites ?? MAX_PENDING_WRITES;

  return router()
    .get("/events", (c) => {
      const type = c.req.query("type");
      if (type && !EVENT_TYPES.includes(type as EventType)) throw badRequest(`type must be one of ${EVENT_TYPES.join(", ")}`);
      const limit = Number(c.req.query("limit"));
      return c.json(
        ctx.events.list({
          accountId: c.req.query("accountId") || undefined,
          type: (type as EventType) || undefined,
          cursor: cursorParam(c.req.query("cursor")),
          limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
        }),
      );
    })
    .get("/events/stream", (c) => {
      c.header("X-Accel-Buffering", "no"); // nginx: don't buffer the stream
      return streamSSE(c, async (stream) => {
        // Serialize writes so messages keep bus order.
        let chain: Promise<unknown> = Promise.resolve();
        let pending = 0;
        const enqueue = (write: () => Promise<unknown>) => {
          if (stream.aborted) return;
          if (++pending > maxPending) return stream.abort();
          chain = chain.then(write).finally(() => pending--);
        };
        const send = (msg: ConsoleStreamMessage) => enqueue(() => stream.writeSSE({ data: JSON.stringify(msg) }));
        enqueue(() => stream.write(": connected\n\n"));
        const listeners = CHANNELS.map((kind) => {
          const listener = (data: unknown) => send({ kind, data } as ConsoleStreamMessage);
          ctx.bus.on(kind, listener);
          return () => ctx.bus.off(kind, listener);
        });
        const heartbeat = setInterval(() => enqueue(() => stream.write(": ping\n\n")), heartbeatMs);

        await new Promise<void>((resolve) => {
          if (stream.aborted || c.req.raw.signal.aborted) return resolve();
          stream.onAbort(resolve);
          c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        clearInterval(heartbeat);
        for (const off of listeners) off();
      });
    });
}
