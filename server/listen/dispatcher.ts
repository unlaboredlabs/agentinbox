import type { WebhookPayload } from "../../shared/types.ts";

export type Target = "exec" | "forward";

export interface Job {
  /** Seq of the job's first event (its place in the acknowledgement order). */
  seq: number;
  /** The first event (the only one unless batched). */
  payload: WebhookPayload;
  /** Every event in this job, oldest first: one, or a --batch. */
  payloads: WebhookPayload[];
  /** Seq of the job's newest event: the cursor may advance to it once the job is finished. */
  lastSeq: number;
  /** Targets still to succeed. A retry only re-runs these (exec and forward are tracked separately). */
  remaining: Set<Target>;
  /** Seqs already forwarded (a batch is forwarded one event at a time; a retry skips these). */
  forwarded: Set<number>;
  attempts: number;
  lastError: string | null;
  /** Set by `run` when the receiver said "too many requests": retry after this long, without using up an attempt. */
  retryAfterMs?: number;
  /** Attempts that ended rate-limited (they don't count, up to MAX_DEFERRALS). */
  deferrals: number;
  state: "collecting" | "queued" | "running" | "waiting" | "done";
  outcome?: "succeeded" | "dead" | "skipped";
  firstSeenAt: number;
}

export interface DispatcherOptions {
  targets: Target[];
  concurrency: number;
  maxAttempts: number;
  /** Collect events for windowMs after the first one (or until `max` events) and run them as one job. */
  batch?: { windowMs: number; max: number };
  /** Delay before retry number `attempt` (1-based). Default: 5 s doubling, capped at 5 min, ±20 % jitter. */
  retryDelayMs?: (attempt: number) => number;
  /** Runs the job's remaining targets once; removes the ones that succeeded from job.remaining and returns the errors of the rest. */
  run: (job: Job, signal: AbortSignal) => Promise<string[]>;
  /** The contiguous prefix of finished events advanced to `seq`: acknowledge it on the server. */
  onAdvance: (seq: number) => void;
  onDead: (job: Job) => void;
  onFinished?: (job: Job) => void;
  onRetry?: (job: Job, delayMs: number) => void;
}

export const defaultRetryDelay = (attempt: number) => Math.min(5000 * 2 ** (attempt - 1), 300_000) * (0.8 + Math.random() * 0.4);
/** Rate-limited attempts that don't count against --max-attempts, per job; after that they do. */
export const MAX_DEFERRALS = 20;

/**
 * Runs events with bounded concurrency and retries, and tracks the **contiguous prefix** of finished
 * events (succeeded, dead or filtered out). Only that prefix is acknowledged, so a crash never loses
 * an event that was still running, collecting into a batch, or waiting to retry: it is delivered
 * again on restart (at-least-once; handlers dedupe on the event id). Events can finish out of order
 * when concurrency is above 1 or an event is waiting for a retry. A batch job takes its first event's
 * place in that order, so nothing after it is acknowledged before the whole batch has finished.
 */
export class Dispatcher {
  private readonly jobs: Job[] = [];
  private running = 0;
  private highestSeen = 0;
  private advancedTo = 0;
  private stopped = false;
  private readonly controller = new AbortController();
  private readonly timers = new Set<NodeJS.Timeout>();
  private idleWaiters: (() => void)[] = [];
  /** The batch still collecting events, if any. */
  private open: { job: Job; timer: NodeJS.Timeout } | null = null;

  constructor(private readonly opts: DispatcherOptions) {}

  /** Highest seq received this session (sent as Last-Event-ID on reconnect). */
  get lastSeq(): number {
    return this.highestSeen;
  }
  /** Seq the finished prefix reaches. */
  get finishedThrough(): number {
    return this.advancedTo;
  }
  /** Events received but not yet started (for stream backpressure). */
  get backlog(): number {
    return this.jobs.filter((j) => j.state === "queued" || j.state === "collecting").reduce((n, j) => n + j.payloads.length, 0);
  }
  get inFlight(): number {
    return this.jobs.filter((j) => j.state !== "done").length;
  }

  /** Seeds the position (the server's acked cursor) so older replays are ignored. */
  seed(seq: number): void {
    this.highestSeen = Math.max(this.highestSeen, seq);
    this.advancedTo = Math.max(this.advancedTo, seq);
  }

  /** Adds an event. Returns false when it is a duplicate of one already seen this session. */
  push(payload: WebhookPayload, opts: { skip?: boolean; targets?: Target[] } = {}): boolean {
    const seq = payload.data.seq;
    if (this.stopped || seq <= this.highestSeen) return false;
    this.highestSeen = seq;
    const remaining = new Set(opts.targets ? this.opts.targets.filter((t) => opts.targets!.includes(t)) : this.opts.targets);
    const batch = this.opts.batch && !opts.targets ? this.opts.batch : null;
    if (!opts.skip && remaining.size && batch && this.open) {
      const job = this.open.job;
      job.payloads.push(payload);
      job.lastSeq = seq;
      if (job.payloads.length >= batch.max) this.close();
      return true;
    }
    const job: Job = { seq, payload, payloads: [payload], lastSeq: seq, remaining, forwarded: new Set(), attempts: 0, deferrals: 0, lastError: null, state: "queued", firstSeenAt: Date.now() };
    this.jobs.push(job);
    if (opts.skip || remaining.size === 0) {
      job.state = "done";
      job.outcome = "skipped";
      this.advance();
    } else if (batch && batch.max > 1) {
      job.state = "collecting";
      const timer = setTimeout(() => this.close(), batch.windowMs);
      this.open = { job, timer };
    } else {
      this.pump();
    }
    return true;
  }

  /** Ends the collecting batch: it runs as soon as a slot is free. */
  private close(): void {
    if (!this.open) return;
    clearTimeout(this.open.timer);
    this.open.job.state = "queued";
    this.open = null;
    this.pump();
  }

  private pump(): void {
    if (this.stopped) return;
    for (const job of this.jobs) {
      if (this.running >= this.opts.concurrency) break;
      if (job.state === "queued") void this.start(job);
    }
  }

  private async start(job: Job): Promise<void> {
    job.state = "running";
    job.attempts++;
    job.retryAfterMs = undefined;
    this.running++;
    let errors: string[];
    try {
      errors = await this.opts.run(job, this.controller.signal);
    } catch (err) {
      errors = [err instanceof Error ? err.message : String(err)];
    }
    this.running--;
    if (this.stopped) {
      // Interrupted by shutdown: not finished, so not acknowledged; it comes back on restart.
      job.state = "queued";
      this.notifyIdle();
      return;
    }
    if (job.remaining.size === 0) {
      job.state = "done";
      job.outcome = "succeeded";
      this.opts.onFinished?.(job);
    } else {
      job.lastError = errors.join("; ") || "failed";
      // A rate-limited attempt doesn't use up an attempt (up to MAX_DEFERRALS): the receiver is fine, just busy.
      const deferred = job.retryAfterMs !== undefined && job.deferrals < MAX_DEFERRALS;
      if (deferred) {
        job.deferrals++;
        job.attempts--;
      }
      if (job.attempts >= this.opts.maxAttempts) {
        job.state = "done";
        job.outcome = "dead";
        this.opts.onDead(job);
        this.opts.onFinished?.(job);
      } else {
        job.state = "waiting";
        const delay = deferred ? job.retryAfterMs! : (this.opts.retryDelayMs ?? defaultRetryDelay)(job.attempts);
        this.opts.onRetry?.(job, delay);
        const t = setTimeout(() => {
          this.timers.delete(t);
          if (job.state === "waiting") job.state = "queued";
          this.pump();
        }, delay);
        this.timers.add(t);
      }
    }
    this.advance();
    this.pump();
    this.notifyIdle();
  }

  private advance(): void {
    let to = this.advancedTo;
    while (this.jobs.length && this.jobs[0]!.state === "done") to = this.jobs.shift()!.lastSeq;
    if (to > this.advancedTo) {
      this.advancedTo = to;
      this.opts.onAdvance(to);
    }
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.jobs.length === 0 && this.running === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Resolves once every received event has finished (tests and `dead --replay`). */
  idle(): Promise<void> {
    if (this.jobs.length === 0 && this.running === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** Stops starting work, aborts what is running (process groups are killed) and waits for it to unwind. A collecting batch isn't run (nor acknowledged). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.open) clearTimeout(this.open.timer);
    this.open = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.controller.abort();
    while (this.running > 0) await new Promise((r) => setTimeout(r, 20));
  }
}
