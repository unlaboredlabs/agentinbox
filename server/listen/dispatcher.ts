import type { WebhookPayload } from "../../shared/types.ts";

export type Target = "exec" | "forward";

export interface Job {
  seq: number;
  payload: WebhookPayload;
  /** Targets still to succeed. A retry only re-runs these (exec and forward are tracked separately). */
  remaining: Set<Target>;
  attempts: number;
  lastError: string | null;
  state: "queued" | "running" | "waiting" | "done";
  outcome?: "succeeded" | "dead" | "skipped";
  firstSeenAt: number;
}

export interface DispatcherOptions {
  targets: Target[];
  concurrency: number;
  maxAttempts: number;
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

/**
 * Runs events with bounded concurrency and retries, and tracks the **contiguous prefix** of finished
 * events (succeeded, dead or filtered out). Only that prefix is acknowledged, so a crash never loses
 * an event that was still running or waiting to retry: it is delivered again on restart
 * (at-least-once; handlers dedupe on the event id). Events can finish out of order when concurrency
 * is above 1 or an event is waiting for a retry.
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
    return this.jobs.filter((j) => j.state === "queued").length;
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
    const job: Job = { seq, payload, remaining: new Set(opts.targets ? this.opts.targets.filter((t) => opts.targets!.includes(t)) : this.opts.targets), attempts: 0, lastError: null, state: "queued", firstSeenAt: Date.now() };
    this.jobs.push(job);
    if (opts.skip || job.remaining.size === 0) {
      job.state = "done";
      job.outcome = "skipped";
      this.advance();
    } else {
      this.pump();
    }
    return true;
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
      if (job.attempts >= this.opts.maxAttempts) {
        job.state = "done";
        job.outcome = "dead";
        this.opts.onDead(job);
        this.opts.onFinished?.(job);
      } else {
        job.state = "waiting";
        const delay = (this.opts.retryDelayMs ?? defaultRetryDelay)(job.attempts);
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
    while (this.jobs.length && this.jobs[0]!.state === "done") to = this.jobs.shift()!.seq;
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

  /** Stops starting work, aborts what is running (process groups are killed) and waits for it to unwind. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.controller.abort();
    while (this.running > 0) await new Promise((r) => setTimeout(r, 20));
  }
}
