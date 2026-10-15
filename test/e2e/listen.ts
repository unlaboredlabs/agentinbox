// Harness hooks for `agentinbox connect` (device-flow pairing) and `agentinbox listen` (outbound event
// stream that runs a local command per event). The feature is being built on feat/listen-*; these
// helpers follow the pinned contract (shared/agent-api.ts on feat/listen-base) and are used by the
// placeholder in test/e2e-listen.test.ts. Types are local so this compiles before the feature lands.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AdminClient } from "./harness.ts";
import { resilientFetch } from "./fetch.ts";
import { waitFor } from "./wait.ts";

const REPO = resolve(import.meta.dirname, "..", "..");

// ───────────── Device-flow pairing (agent side + console side) ─────────────

export interface PairingStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
}

export type PairingPoll =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "approved"; apiKey: string; agent: { id: string; name: string }; mcpUrl: string; skillUrl: string }
  | { status: "denied"; note: string | null }
  | { status: "expired" }
  | { status: "consumed" };

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await resilientFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** POST /agent/v1/pairings (public), as `agentinbox connect` does. */
export const startPairing = (baseUrl: string, input: { name: string; description?: string; requested?: Record<string, unknown>; client?: Record<string, unknown> }) =>
  postJson<PairingStart>(`${baseUrl}/agent/v1/pairings`, input);

/** POST /agent/v1/pairings/poll (public). */
export const pollPairing = (baseUrl: string, deviceCode: string) => postJson<PairingPoll>(`${baseUrl}/agent/v1/pairings/poll`, { deviceCode });

/** Console side: find the pending request by the code the agent's terminal shows. */
export async function findPairing(admin: AdminClient, userCode: string): Promise<{ id: string; userCode: string; status: string }> {
  const list = await admin.get<{ id: string; userCode: string; status: string }[]>("/api/pairings?status=pending");
  const found = list.find((p) => p.userCode === userCode);
  if (!found) throw new Error(`no pending pairing with code ${userCode}`);
  return found;
}

export const approvePairing = (admin: AdminClient, id: string, grants: unknown[], name?: string) =>
  admin.post<{ id: string; name: string }>(`/api/pairings/${id}/approve`, { name, grants });

export const denyPairing = (admin: AdminClient, id: string, note?: string) => admin.post(`/api/pairings/${id}/deny`, { note });

// ───────────── Agent event stream (/agent/v1/events/stream) ─────────────

export interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

export interface AgentStream {
  status: number;
  events: SseEvent[];
  comments: string[];
  /** Resolves when the server closes the stream. */
  closed: Promise<void>;
  next(pred: (e: SseEvent) => boolean, timeout?: number): Promise<SseEvent>;
  close(): void;
}

/** Opens the listener stream with a bearer key (what `agentinbox listen` does), parsing id/event/data. */
export async function openAgentStream(
  baseUrl: string,
  apiKey: string,
  query: { consumer: string; after?: number; types?: string[]; includeBody?: boolean },
  headers: Record<string, string> = {},
): Promise<AgentStream> {
  const qs = new URLSearchParams({ consumer: query.consumer });
  if (query.after !== undefined) qs.set("after", String(query.after));
  if (query.types?.length) qs.set("types", query.types.join(","));
  if (query.includeBody) qs.set("include_body", "1");
  const ctrl = new AbortController();
  const res = await resilientFetch(`${baseUrl}/agent/v1/events/stream?${qs}`, {
    headers: { accept: "text/event-stream", authorization: `Bearer ${apiKey}`, ...headers },
    signal: ctrl.signal,
  });
  let resolveClosed!: () => void;
  const stream: AgentStream = {
    status: res.status,
    events: [],
    comments: [],
    closed: new Promise<void>((r) => (resolveClosed = r)),
    next: (pred, timeout = 8000) => waitFor(() => stream.events.find(pred), { timeout, what: "agent stream event" }),
    close: () => ctrl.abort(),
  };
  if (!res.ok || !res.body) {
    resolveClosed();
    return stream;
  }
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: SseEvent = { id: null, event: "message", data: "" };
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) stream.comments.push(line.slice(1).trim());
            else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
            else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length) stream.events.push({ ...ev, data: data.join("\n") });
        }
      }
    } catch {
      // aborted
    } finally {
      resolveClosed();
    }
  })();
  return stream;
}

// ───────────── CLI process ─────────────

export interface CliProcess {
  proc: ChildProcess;
  stdout: string[];
  stderr: string[];
  waitForLine(re: RegExp, timeout?: number): Promise<string>;
  /** Writes a line to the CLI's stdin (interactive prompts). */
  write(line: string): void;
  exited: Promise<number | null>;
  kill(): Promise<void>;
}

/** Runs `agentinbox <args>` from source (node + tsx), with HOME pointed at `home` so profiles stay isolated. */
export function spawnCli(args: string[], opts: { home: string; env?: Record<string, string> }): CliProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", join(REPO, "server", "cli.ts"), ...args], {
    cwd: REPO,
    env: { ...process.env, HOME: opts.home, NO_COLOR: "1", AGENTINBOX_LOG_LEVEL: "info", ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const collect = (into: string[]) => {
    let rest = "";
    return (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      into.push(...lines);
    };
  };
  proc.stdout!.on("data", collect(stdout));
  proc.stderr!.on("data", collect(stderr));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  return {
    proc,
    stdout,
    stderr,
    waitForLine: (re, timeout = 10_000) => waitFor(() => [...stdout, ...stderr].find((l) => re.test(l)), { timeout, what: `CLI output ${re}` }),
    write: (line) => proc.stdin!.write(line + "\n"),
    exited,
    async kill() {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await exited;
    },
  };
}

// ───────────── Command recorder (the `exec` target) ─────────────

export interface RecordedCall {
  stdin: string;
  argv: string[];
  env: Record<string, string>;
}

export interface CommandRecorder {
  /** Pass as the listener's exec command. */
  command: string;
  calls(): RecordedCall[];
  /** A file that only exists if injected shell syntax ran (e.g. `$(touch <canary>)` in a subject). */
  canary: string;
}

/** A tiny node script that records stdin, argv and AGENTINBOX_* env of every invocation into `dir`. */
export function commandRecorder(dir: string): CommandRecorder {
  const calls = join(dir, "calls");
  mkdirSync(calls, { recursive: true });
  const script = join(dir, "record.mjs");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("AGENTINBOX_")));
writeFileSync(${JSON.stringify(calls)} + "/" + Date.now() + "-" + process.pid + ".json", JSON.stringify({ stdin, argv: process.argv.slice(2), env }));
`,
  );
  return {
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
    canary: join(dir, "PWNED"),
    calls: () =>
      readdirSync(calls)
        .sort()
        .map((f) => JSON.parse(readFileSync(join(calls, f), "utf8")) as RecordedCall),
  };
}
