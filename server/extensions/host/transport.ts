// The MCP stdio transport to one code-extension child. Our own, not the SDK's StdioClientTransport: that one merges
// HOME, PATH, USER, SHELL, TERM and LOGNAME into the child's environment (getDefaultEnvironment), spawns through
// cross-spawn, and has its own close timings. This one passes exactly the argv and environment it's given, pipes
// only (no extra fds), `detached: false`, a cap on each stdout message, and SIGTERM then SIGKILL on close.
// Messages are newline-delimited JSON-RPC, parsed by the SDK's deserializeMessage (as its stdio transport does).

import { type ChildProcess, spawn } from "node:child_process";
import { deserializeMessage, type JSONRPCMessage, serializeMessage, type Transport } from "@modelcontextprotocol/client";

export interface ChildTransportOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  maxMessageBytes: number;
  maxStderrLine: number;
  stderrLines: number;
  killAfterMs: number;
  /** Lines from the child's stderr (already capped), for logging. */
  onStderr?(line: string): void;
  /** The child is gone (crash, kill or close). */
  onExit?(info: { code: number | null; signal: NodeJS.Signals | null; reason: string | null }): void;
}

export class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private child: ChildProcess | null = null;
  private exited: Promise<void> | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private stderrPartial = "";
  private readonly stderrRing: string[] = [];
  /** Why we killed it (message too large, protocol garbage), for the crash report. */
  private killReason: string | null = null;

  constructor(private readonly o: ChildTransportOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The last stderr lines (not redacted: the caller redacts before showing or storing them). */
  stderrTail(): string[] {
    return [...this.stderrRing, ...(this.stderrPartial ? [this.stderrPartial.slice(0, this.o.maxStderrLine)] : [])];
  }

  start(): Promise<void> {
    if (this.child) throw new Error("ChildTransport already started");
    return new Promise((resolveStart, rejectStart) => {
      const child = spawn(this.o.command, this.o.args, {
        cwd: this.o.cwd,
        env: this.o.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
        shell: false,
        windowsHide: true,
      });
      this.child = child;
      let started = false;
      this.exited = new Promise((done) => {
        child.once("exit", (code, signal) => {
          this.o.onExit?.({ code, signal, reason: this.killReason });
          done();
        });
        child.once("error", (err) => {
          if (!started) done();
          this.onerror?.(err);
        });
      });
      child.once("spawn", () => {
        started = true;
        resolveStart();
      });
      child.once("error", (err) => {
        if (!started) rejectStart(err);
      });
      child.once("close", () => {
        this.onclose?.();
      });
      child.stdin!.on("error", (err) => this.onerror?.(err));
      child.stdout!.on("error", (err) => this.onerror?.(err));
      child.stderr!.on("error", () => {});
      child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (s: string) => this.onStderrData(s));
    });
  }

  private onStdout(chunk: Buffer): void {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, from);
      if (nl === -1) break;
      const part = chunk.subarray(from, nl);
      if (this.pendingBytes + part.length > this.o.maxMessageBytes) return this.tooLarge();
      this.pending.push(part);
      const line = Buffer.concat(this.pending).toString("utf8").replace(/\r$/, "");
      this.pending = [];
      this.pendingBytes = 0;
      from = nl + 1;
      if (line.trim()) this.deliver(line);
      if (this.killReason) return;
    }
    const rest = chunk.subarray(from);
    if (!rest.length) return;
    if (this.pendingBytes + rest.length > this.o.maxMessageBytes) return this.tooLarge();
    this.pending.push(rest);
    this.pendingBytes += rest.length;
  }

  private deliver(line: string): void {
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line);
    } catch {
      // Not JSON-RPC: dropped (a stray console.log on stdout). The caller counts these through onerror.
      this.onerror?.(new Error("The extension wrote something that isn't a JSON-RPC message to stdout"));
      return;
    }
    this.onmessage?.(message);
  }

  private tooLarge(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.killReason = `it sent a message over ${Math.round(this.o.maxMessageBytes / 1024 / 1024)} MB`;
    this.onerror?.(new Error(`The extension sent a message over the ${this.o.maxMessageBytes}-byte limit`));
    this.child?.kill("SIGKILL");
  }

  private onStderrData(s: string): void {
    const text = this.stderrPartial + s;
    const lines = text.split("\n");
    this.stderrPartial = lines.pop()!.slice(0, this.o.maxStderrLine * 4);
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "").slice(0, this.o.maxStderrLine);
      if (!line.trim()) continue;
      this.stderrRing.push(line);
      if (this.stderrRing.length > this.o.stderrLines) this.stderrRing.shift();
      this.o.onStderr?.(line);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolveSend, rejectSend) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) return rejectSend(new Error("The extension isn't running"));
      if (stdin.write(serializeMessage(message))) resolveSend();
      else stdin.once("drain", () => resolveSend());
    });
  }

  /** Ends stdin, sends SIGTERM, then SIGKILL after killAfterMs; resolves once the child has exited. */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, this.o.killAfterMs);
      timer.unref();
      await this.exited;
      clearTimeout(timer);
    } else await this.exited;
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  }
}
