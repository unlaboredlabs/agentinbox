import pc from "picocolors";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.AGENTINBOX_LOG_LEVEL as Level) ?? "info"] ?? 20;
const color: Record<Level, (s: string) => string> = { debug: pc.gray, info: pc.cyan, warn: pc.yellow, error: pc.red };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope = "agentinbox"): Logger {
  const emit = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (order[level] < min) return;
    const ts = new Date().toISOString().slice(11, 19);
    const extra = meta && Object.keys(meta).length ? " " + pc.gray(JSON.stringify(meta)) : "";
    const line = `${pc.gray(ts)} ${color[level](level.padEnd(5))} ${pc.bold(scope)} ${msg}${extra}`;
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, x) => emit("debug", m, x),
    info: (m, x) => emit("info", m, x),
    warn: (m, x) => emit("warn", m, x),
    error: (m, x) => emit("error", m, x),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
