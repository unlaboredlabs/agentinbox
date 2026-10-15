import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventType, WebhookPayload } from "../../shared/types.ts";
import type { Target } from "./dispatcher.ts";
import { ensurePrivateDir, tighten, writePrivateFile } from "./fsutil.ts";
import { join } from "node:path";
import { deadPath, profileStateDir, statusPath } from "./paths.ts";

// ───────────── Dead letters ─────────────

export interface DeadEntry {
  deadAt: string;
  seq: number;
  id: string;
  type: EventType;
  attempts: number;
  error: string;
  /** Targets that never succeeded (a replay only re-runs these). */
  targets: Target[];
  payload: WebhookPayload;
}

export function appendDead(profile: string, entry: DeadEntry): void {
  const path = deadPath(profile);
  ensurePrivateDir(dirname(path));
  appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
  tighten(path);
}

export function readDead(profile: string): DeadEntry[] {
  const path = deadPath(profile);
  if (!existsSync(path)) return [];
  const out: DeadEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DeadEntry);
    } catch {
      // A torn last line after a crash: skip it.
    }
  }
  return out;
}

export function writeDead(profile: string, entries: DeadEntry[]): void {
  writePrivateFile(deadPath(profile), entries.map((e) => JSON.stringify(e) + "\n").join(""));
}

// ───────────── Consumers this machine has used (the daemon creates a cursor on first connect) ─────────────

const consumersPath = (profile: string) => join(profileStateDir(profile), "consumers.json");

export function knownConsumers(profile: string): string[] {
  const list: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(consumersPath(profile), "utf8")) as unknown;
    if (Array.isArray(parsed)) list.push(...parsed.filter((c): c is string => typeof c === "string"));
  } catch {
    // None yet.
  }
  const last = readStatus(profile)?.consumer;
  if (last && !list.includes(last)) list.push(last);
  return list;
}

export function rememberConsumer(profile: string, consumer: string): void {
  const list = knownConsumers(profile);
  if (list.includes(consumer)) return;
  try {
    writePrivateFile(consumersPath(profile), JSON.stringify([...list, consumer]) + "\n");
  } catch {
    // Best effort: only affects the first-run hints.
  }
}

// ───────────── Status (for `listen status`) ─────────────

export interface RecentEvent {
  seq: number;
  id: string;
  type: EventType;
  outcome: "succeeded" | "dead" | "skipped" | "retrying";
  attempts: number;
  at: string;
  error?: string | null;
}

export interface ListenStatus {
  pid: number;
  profile: string;
  url: string;
  consumer: string;
  version: string;
  startedAt: string;
  connected: boolean;
  connectedSince: string | null;
  lastDisconnect: { at: string; reason: string } | null;
  lastEventAt: string | null;
  receivedSeq: number;
  ackedSeq: number;
  running: number;
  recent: RecentEvent[];
  stoppedAt: string | null;
  exitReason: string | null;
  /** What the (last) run executed, flags included. */
  exec?: string | null;
  forward?: string | null;
}

export function readStatus(profile: string): ListenStatus | null {
  try {
    return JSON.parse(readFileSync(statusPath(profile), "utf8")) as ListenStatus;
  } catch {
    return null;
  }
}

/** Writes status.json at most once a second (and immediately on `flush`). */
export class StatusWriter {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly profile: string,
    readonly status: ListenStatus,
  ) {}

  update(patch: Partial<ListenStatus>): void {
    Object.assign(this.status, patch);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref();
  }

  addRecent(e: RecentEvent): void {
    this.status.recent = [e, ...this.status.recent.filter((r) => r.seq !== e.seq)].slice(0, 20);
    this.update({});
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writePrivateFile(statusPath(this.profile), JSON.stringify(this.status, null, 2) + "\n");
    } catch {
      // Status is best effort.
    }
  }
}

/** Whether a process with this pid is alive (status.json may be left over from a crash). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
