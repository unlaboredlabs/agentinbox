// Content cleaning runs in worker threads with a hard deadline. Any sender controls the HTML being parsed
// and converted, and synchronous CPU work can't be interrupted by a timeout on the main thread, so a
// pathological message must never be able to block the event loop (MCP calls, webhooks, the console).
// On timeout the worker is terminated and replaced, and the message falls back to its cleaned
// text/plain part (or a notice): see fallbackContent.

import { Worker } from "node:worker_threads";
import type { AppContext } from "../context.ts";
import type { ParsedMessage } from "../google/types.ts";
import { errorMessage } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { type BuiltContent, buildContent, fallbackContent, htmlToMarkdown } from "./content.ts";
import type { ContentReply, ContentTask } from "./content-worker.ts";

/** Source mode (tsx/vitest) loads the .ts worker; the build emits dist/content-worker.js next to dist/cli.js. */
const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./content-worker.ts" : "./content-worker.js", import.meta.url);

export const CONTENT_DEADLINE_MS = 2_000;
const POOL_SIZE = 2;
/** Workers that die before becoming ready this many times in a row: clean in-process instead. */
const MAX_START_FAILURES = 2;

type ContentOpts = { accountEmail: string; maxChars: number };
type TaskInput = { kind: "content"; parsed: ParsedMessage; opts: ContentOpts } | { kind: "html"; html: string };

interface Job {
  task: ContentTask;
  resolve(value: unknown): void;
  fallback(): unknown;
  inline(): unknown;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  timer?: NodeJS.Timeout;
}

export interface PoolOptions {
  size?: number;
  deadlineMs?: number;
  workerUrl?: URL;
}

export class ContentPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private startFailures = 0;
  /** Workers can't start in this environment: clean in-process (bounded only by the content caps). */
  private inline = false;
  private closed = false;
  private readonly size: number;
  private readonly deadlineMs: number;
  private readonly workerUrl: URL;

  constructor(
    private readonly log: Logger,
    opts: PoolOptions = {},
  ) {
    this.size = opts.size ?? POOL_SIZE;
    this.deadlineMs = opts.deadlineMs ?? CONTENT_DEADLINE_MS;
    this.workerUrl = opts.workerUrl ?? WORKER_URL;
  }

  /** Cleaned content for a parsed message; falls back to the text part when the deadline passes. */
  content(parsed: ParsedMessage, opts: ContentOpts): Promise<BuiltContent> {
    return this.run(
      { kind: "content", parsed, opts },
      () => fallbackContent(parsed, opts),
      () => buildContent(parsed, opts),
    ) as Promise<BuiltContent>;
  }

  /** HTML → cleaned markdown (HTML attachments). */
  html(html: string): Promise<{ markdown: string; removed: number }> {
    return this.run(
      { kind: "html", html },
      () => ({ markdown: "[This HTML is too complex to display safely.]", removed: 0 }),
      () => htmlToMarkdown(html),
    ) as Promise<{ markdown: string; removed: number }>;
  }

  async close(): Promise<void> {
    this.closed = true;
    const slots = this.slots;
    this.slots = [];
    for (const slot of slots) this.finish(slot, null);
    for (const job of this.queue.splice(0)) job.resolve(job.fallback());
    await Promise.all(slots.map((s) => s.worker.terminate().catch(() => 0)));
  }

  private run(input: TaskInput, fallback: () => unknown, inline: () => unknown): Promise<unknown> {
    if (this.inline) return Promise.resolve().then(inline);
    if (this.closed) return Promise.resolve().then(fallback);
    return new Promise((resolve) => {
      this.queue.push({ task: { ...input, id: this.nextId++ } as ContentTask, resolve, fallback, inline });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inline) {
      for (const job of this.queue.splice(0)) {
        try {
          job.resolve(job.inline());
        } catch {
          job.resolve(job.fallback());
        }
      }
      return;
    }
    while (this.queue.length) {
      const slot = this.slots.find((s) => s.ready && !s.job);
      if (!slot) {
        if (this.slots.length < this.size && !this.closed) this.spawn();
        return;
      }
      this.dispatch(slot, this.queue.shift()!);
    }
  }

  private spawn(): void {
    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl, { resourceLimits: { maxOldGenerationSizeMb: 256 } });
    } catch (err) {
      this.startFailed(err);
      return;
    }
    worker.unref();
    const slot: Slot = { worker, ready: false, job: null };
    this.slots.push(slot);
    worker.on("message", (m: ContentReply) => {
      if ("ready" in m) {
        slot.ready = true;
        this.startFailures = 0;
        this.pump();
        return;
      }
      const job = slot.job;
      if (!job || job.task.id !== m.id) return;
      if (!m.ok) this.log.debug("Content cleaning failed in worker", { error: m.error });
      this.finish(slot, m.ok ? m.result : job.fallback());
      this.pump();
    });
    worker.on("error", (err) => this.lost(slot, err));
    worker.on("exit", (code) => this.lost(slot, new Error(`content worker exited with code ${code}`)));
  }

  private dispatch(slot: Slot, job: Job): void {
    slot.job = job;
    slot.timer = setTimeout(() => {
      if (slot.job !== job) return;
      this.log.warn("Content cleaning exceeded its deadline; restarting the worker", { deadlineMs: this.deadlineMs, kind: job.task.kind });
      this.remove(slot);
      this.finish(slot, job.fallback());
      void slot.worker.terminate().catch(() => 0);
      this.pump();
    }, this.deadlineMs);
    slot.timer.unref();
    slot.worker.postMessage(job.task);
  }

  /** Resolves the slot's current job (if any) with `value`. */
  private finish(slot: Slot, value: unknown): void {
    if (slot.timer) clearTimeout(slot.timer);
    const job = slot.job;
    slot.job = null;
    if (job) job.resolve(value ?? job.fallback());
  }

  private remove(slot: Slot): boolean {
    const i = this.slots.indexOf(slot);
    if (i < 0) return false;
    this.slots.splice(i, 1);
    return true;
  }

  private lost(slot: Slot, err: unknown): void {
    if (!this.remove(slot)) return;
    this.finish(slot, null);
    if (this.closed) return;
    if (!slot.ready) this.startFailed(err);
    else this.log.warn("Content worker stopped unexpectedly; it will be replaced", { error: errorMessage(err) });
    this.pump();
  }

  private startFailed(err: unknown): void {
    if (++this.startFailures < MAX_START_FAILURES) return;
    this.inline = true;
    this.log.warn("Content worker could not start; cleaning content in-process", { error: errorMessage(err) });
  }
}

const pools = new WeakMap<AppContext, ContentPool>();

/** The context's pool, created lazily (no threads until content is first cleaned). */
export function contentPool(ctx: AppContext): ContentPool {
  let pool = pools.get(ctx);
  if (!pool) pools.set(ctx, (pool = new ContentPool(ctx.log.child("content"))));
  return pool;
}

export async function closeContentPool(ctx: AppContext): Promise<void> {
  const pool = pools.get(ctx);
  pools.delete(ctx);
  await pool?.close();
}
