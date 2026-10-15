import type { EventType } from "../../shared/types.ts";
import { apiError, describeFetchError, userAgent } from "./api.ts";
import { SseParser, type SseMessage } from "./sse.ts";

export type StreamEnd = { kind: "revoked"; reason: string } | { kind: "fatal"; reason: string } | { kind: "stopped" };

export interface StreamOptions {
  url: string;
  apiKey: string;
  consumer: string;
  types?: EventType[];
  includeBody?: boolean;
  /** Highest seq received so far, sent as Last-Event-ID on reconnect (0 = let the server cursor decide). */
  lastEventId: () => number;
  onOpen: () => void;
  onMessage: (m: SseMessage) => void;
  /** Connection lost / failed; reconnecting after `retryInMs`. */
  onDisconnect: (reason: string, retryInMs: number, opts: { serious: boolean }) => void;
  /** True while the local backlog is too large: the stream disconnects and resumes once it drains. */
  shouldPause?: () => boolean;
  /** Silence (no events, no pings) after which the connection is presumed dead. The server pings every 15 s. */
  stallMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

class Stalled extends Error {}
class Paused extends Error {}
class Reconnect extends Error {}

const sleepJump = 20_000;

/**
 * Holds the outbound event stream open forever: reconnects with jittered exponential backoff,
 * resumes with Last-Event-ID (the server also resumes from the consumer's acked cursor), treats
 * ~45 s of silence as a dead connection, and reconnects at once after the machine wakes from sleep.
 * Only revocation (401/403 or `event: revoked`) and unrecoverable request errors end it.
 */
export class EventStream {
  private stopped = false;
  private current: AbortController | null = null;
  private wake: (() => void) | null = null;
  private failures = 0;

  constructor(private readonly o: StreamOptions) {}

  stop(): void {
    this.stopped = true;
    this.current?.abort();
    this.wake?.();
  }

  /** Forces a reconnect now (network change, wake from sleep). */
  reconnect(): void {
    this.failures = 0;
    this.current?.abort(new Reconnect("reconnect requested"));
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  private backoff(): number {
    const min = this.o.minBackoffMs ?? 1000;
    const max = this.o.maxBackoffMs ?? 60_000;
    const cap = Math.min(max, min * 2 ** Math.min(this.failures, 16));
    // Full jitter, but never below `min`, so a fleet of laptops waking together doesn't stampede.
    return Math.round(min + Math.random() * (cap - min));
  }

  private streamUrl(): string {
    const u = new URL(`${this.o.url}/agent/v1/events/stream`);
    u.searchParams.set("consumer", this.o.consumer);
    if (this.o.types?.length) u.searchParams.set("types", this.o.types.join(","));
    if (this.o.includeBody) u.searchParams.set("include_body", "1");
    return u.toString();
  }

  async run(): Promise<StreamEnd> {
    // Laptop sleep: timers stall while suspended, so a big jump in wall-clock time means we just woke up.
    let lastTick = Date.now();
    const sleepWatch = setInterval(() => {
      const now = Date.now();
      if (now - lastTick > sleepJump) this.reconnect();
      lastTick = now;
    }, 5000);
    sleepWatch.unref();
    try {
      while (!this.stopped) {
        while (this.o.shouldPause?.() && !this.stopped) await this.sleep(250);
        if (this.stopped) break;
        const result = await this.connectOnce();
        if (result) return result;
      }
      return { kind: "stopped" };
    } finally {
      clearInterval(sleepWatch);
    }
  }

  /** One connection. Returns a terminal result, or null to reconnect (after waiting, unless paused). */
  private async connectOnce(): Promise<StreamEnd | null> {
    const ac = new AbortController();
    this.current = ac;
    const stallMs = this.o.stallMs ?? 45_000;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ac.abort(new Stalled(`no data or ping for ${Math.round(stallMs / 1000)} s`)), stallMs);
    };
    const opened = Date.now();
    let delivered = false;
    let revoked: string | null = null;

    try {
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        authorization: `Bearer ${this.o.apiKey}`,
        "cache-control": "no-cache",
        "user-agent": userAgent(),
      };
      const last = this.o.lastEventId();
      if (last > 0) headers["last-event-id"] = String(last);
      armStall();
      const res = await fetch(this.streamUrl(), { headers, signal: ac.signal, redirect: "error" });
      if (!res.ok) {
        const err = await apiError(res, "Opening the event stream");
        if (res.status === 401 || res.status === 403) return { kind: "revoked", reason: err.message };
        if (res.status === 400 || res.status === 422) return { kind: "fatal", reason: err.message };
        clearTimeout(stallTimer);
        const longWait = res.status === 404 ? 300_000 : null;
        if (res.status === 404) {
          this.disconnected("This agentinbox server has no /agent/v1 event stream (upgrade the daemon). Retrying in 5 minutes", longWait!, true);
          await this.sleep(longWait!);
        } else {
          this.failures++;
          const wait = err.retryAfter ? err.retryAfter * 1000 : this.backoff();
          this.disconnected(err.message, wait, res.status >= 500 || res.status === 429 ? false : true);
          await this.sleep(wait);
        }
        return null;
      }
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
        throw new Error(`expected text/event-stream, got ${res.headers.get("content-type") ?? "no content type"}`);
      }
      this.o.onOpen();
      armStall();

      const parser = new SseParser(
        (m) => {
          if (m.event === "revoked") {
            let reason = "access revoked";
            try {
              reason = (JSON.parse(m.data) as { reason?: string }).reason ?? reason;
            } catch {
              // Keep the default.
            }
            revoked = reason;
            ac.abort();
            return;
          }
          delivered = true;
          this.o.onMessage(m);
          if (this.o.shouldPause?.()) ac.abort(new Paused("backlog full"));
        },
        () => {},
      );
      const decoder = new TextDecoder();
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        armStall();
        parser.push(decoder.decode(chunk, { stream: true }));
        if (revoked !== null) break;
      }
      if (revoked !== null) return { kind: "revoked", reason: revoked };
      throw new Error("the server closed the stream");
    } catch (err) {
      if (revoked !== null) return { kind: "revoked", reason: revoked };
      if (this.stopped) return { kind: "stopped" };
      const reason = ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err;
      if (reason instanceof Paused) return null;
      // A connection that was healthy for a while (or delivered events) starts the backoff over.
      if (delivered || Date.now() - opened > 60_000) this.failures = 0;
      if (reason instanceof Reconnect) {
        this.disconnected("reconnecting (network change or wake from sleep)", 0, false);
        return null;
      }
      this.failures++;
      const wait = this.backoff();
      const text = reason instanceof Stalled ? `stream stalled (${reason.message})` : describeFetchError(reason);
      this.disconnected(text, wait, this.failures > 3);
      await this.sleep(wait);
      return null;
    } finally {
      clearTimeout(stallTimer);
      ac.abort();
      this.current = null;
    }
  }

  private disconnected(reason: string, wait: number, serious: boolean): void {
    if (!this.stopped) this.o.onDisconnect(reason, wait, { serious });
  }
}
