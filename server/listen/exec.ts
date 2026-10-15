import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebhookPayload } from "../../shared/types.ts";
import { commandInput, eventEnv } from "./event.ts";

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  error: string | null;
}

const TAIL = 4000;
const KILL_GRACE_MS = 5000;

class Tail {
  private buf = "";
  push(chunk: Buffer): void {
    this.buf = (this.buf + chunk.toString("utf8")).slice(-TAIL);
  }
  toString(): string {
    return this.buf;
  }
}

/**
 * The child's environment: ours minus anything agentinbox-specific (service flags, a master key that
 * happened to be exported…), plus the safe event ids and the event file path.
 */
export function childEnv(payload: WebhookPayload, eventFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("AGENTINBOX_")) env[k] = v;
  return { ...env, ...eventEnv(payload), AGENTINBOX_EVENT_FILE: eventFile };
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    // Negative pid: the whole process group (the child is its leader thanks to `detached`).
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Runs the configured command for one event. The command string is fixed configuration and goes to
 * `/bin/sh -c` verbatim; it is never built from event data. The event reaches the command only as
 * JSON on stdin, as a 0600 file named by AGENTINBOX_EVENT_FILE, and as a few validated ids in env.
 * On timeout the whole process group gets SIGTERM, then SIGKILL after a grace period.
 */
export function runCommand(command: string, payload: WebhookPayload, opts: { timeoutMs: number; cwd?: string; signal?: AbortSignal }): Promise<CommandResult> {
  const started = performance.now();
  const input = JSON.stringify(commandInput(payload), null, 2) + "\n";
  // mkdtemp creates the directory 0700; the file inside is 0600 on top.
  const dir = mkdtempSync(join(tmpdir(), "agentinbox-event-"));
  const eventFile = join(dir, "event.json");
  writeFileSync(eventFile, input, { mode: 0o600, flag: "wx" });

  return new Promise<CommandResult>((resolve) => {
    const stdout = new Tail();
    const stderr = new Tail();
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: childEnv(payload, eventFile),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const finish = (r: Omit<CommandResult, "durationMs" | "stdoutTail" | "stderrTail" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (timedOut) killGroup(child.pid, "SIGKILL");
      // Background processes that inherited the pipes must not keep us waiting.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        rmSync(dir, { recursive: true, force: true });
        resolve({ ...r, ok: r.ok && !timedOut, timedOut, durationMs: Math.round(performance.now() - started), stdoutTail: stdout.toString(), stderrTail: stderr.toString() });
      }, 50);
    };

    const terminate = () => {
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    const onAbort = () => terminate();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    // A command that doesn't read stdin closes the pipe early: that's fine.
    child.stdin.on("error", () => {});
    child.stdin.end(input);

    child.on("error", (err) => finish({ ok: false, exitCode: null, signal: null, error: `Could not start /bin/sh: ${err.message}` }));
    child.on("exit", (code, signal) => {
      const error = timedOut
        ? `Timed out after ${Math.round(opts.timeoutMs / 1000)} s; the process group was killed`
        : signal
          ? `Killed by ${signal}`
          : code !== 0
            ? `Exited with code ${code}`
            : null;
      finish({ ok: code === 0 && !signal, exitCode: code, signal: signal ?? null, error });
    });
  });
}
