import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import pc from "picocolors";
import { ensurePrivateDir } from "./fsutil.ts";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export type Level = "debug" | "info" | "warn" | "error";

export interface ListenLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface LogFileOptions {
  path: string | null;
  /** Rotate when the file passes this size. */
  maxBytes?: number;
  /** Rotated files kept (listen.log.1 … .N). */
  keep?: number;
  /** Console output: friendly one-liners (meta is file-only). */
  console?: boolean;
  debug?: boolean;
}

/**
 * Structured JSONL log in the state dir (rotated by size, 0600) plus friendly console lines.
 * Meta values go to the file only; the console shows the message.
 */
export function createListenLogger(opts: LogFileOptions): ListenLogger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  let size = -1;
  if (opts.path) ensurePrivateDir(dirname(opts.path));

  const rotate = (path: string) => {
    rmSync(`${path}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    renameSync(path, `${path}.1`);
    size = 0;
  };

  const toFile = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (!opts.path) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: msg.replace(ANSI, ""), ...meta }) + "\n";
    try {
      if (size < 0) size = existsSync(opts.path) ? statSync(opts.path).size : 0;
      if (size + line.length > maxBytes && size > 0) rotate(opts.path);
      appendFileSync(opts.path, line, { mode: 0o600 });
      size += Buffer.byteLength(line);
    } catch {
      // Logging must never take the listener down (disk full, dir removed…).
    }
  };

  const colors: Record<Level, (s: string) => string> = { debug: pc.gray, info: (s) => s, warn: pc.yellow, error: pc.red };
  const toConsole = (level: Level, msg: string) => {
    if (opts.console === false || (level === "debug" && !opts.debug)) return;
    const ts = pc.gray(new Date().toTimeString().slice(0, 8));
    const tag = level === "warn" ? pc.yellow("warn ") : level === "error" ? pc.red("error ") : "";
    // Callers sanitize untrusted parts (subjects, senders, command output) with safeText.
    const text = msg.split("\n").join("\n  ");
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${ts} ${tag}${colors[level](text)}\n`);
  };

  const emit = (level: Level) => (msg: string, meta?: Record<string, unknown>) => {
    toFile(level, msg, meta);
    toConsole(level, msg);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
