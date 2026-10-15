import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import open from "open";
import pc from "picocolors";
import { createApp } from "./app.ts";
import { currentSetupToken } from "./auth/index.ts";
import { type Config, type ConfigInput, loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { startMaintenance } from "./maintenance.ts";
import { consoleUrls, loopbackUrl } from "./urls.ts";
import { errorMessage } from "./util/errors.ts";
import { createAppContext, type ServiceOverrides, startServices, stopServices } from "./wire.ts";

export interface StartOptions {
  config: Config;
  /** Replace services with fakes (tests). */
  overrides?: ServiceOverrides;
  /** Console build directory (defaults to dist/web). */
  webDir?: string;
}

export interface RunningServer {
  /** Base URL reachable from this machine, e.g. http://127.0.0.1:54321. */
  url: string;
  ctx: AppContext;
  server: ServerType;
  /** Stops accepting requests, stops services and closes the database. Idempotent. */
  close(): Promise<void>;
}

/**
 * Builds the context, binds the port, then starts services (so a second instance that can't bind
 * never runs ingest against the same data). Use `port: 0` in tests; `config.port` is updated to
 * the bound port.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  const ctx = createAppContext(config, opts.overrides);
  let server: ServerType;
  try {
    const app = createApp(ctx, { webDir: opts.webDir });
    server = await listen(app.fetch, config.host, config.port);
  } catch (err) {
    ctx.db.close();
    throw friendlyListenError(err, config.port);
  }
  config.port = (server.address() as AddressInfo).port;

  let stopMaintenance = () => {};
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopMaintenance();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // SSE streams and long polls would otherwise hold the server open.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await stopServices(ctx);
    })());

  try {
    await startServices(ctx);
  } catch (err) {
    await close();
    throw err;
  }
  stopMaintenance = startMaintenance(ctx);
  return { url: loopbackUrl(config.host, config.port), ctx, server, close };
}

function listen(fetch: Parameters<typeof serve>[0]["fetch"], hostname: string, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, hostname, port }, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

function friendlyListenError(err: unknown, port: number): Error {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") return new Error(`Port ${port} is already in use (is agentinbox already running?). Try --port <port>.`);
  if (code === "EACCES") return new Error(`Not allowed to listen on port ${port}. Use a port above 1024, e.g. --port 8425.`);
  if (code === "EADDRNOTAVAIL") return new Error(`Can't bind to that address. Check --host.`);
  return err instanceof Error ? err : new Error(String(err));
}

export interface RunOptions extends ConfigInput {
  /** Open the setup link in a browser on first run. */
  open?: boolean;
  version: string;
}

/** `agentinbox start`: runs in the foreground until SIGINT/SIGTERM. */
export async function runForeground(opts: RunOptions): Promise<void> {
  const config = loadConfig(opts, opts.version);
  const running = await startServer({ config });
  printBanner(running.ctx);

  const token = currentSetupToken(running.ctx);
  if (token && opts.open && process.stdout.isTTY && !config.dev && !config.service) {
    openBrowser(`${consoleUrls(config.host, config.port)[0]}/setup?token=${token}`);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(pc.dim(`\n  Stopping agentinbox…`));
      running.close().then(
        () => process.exit(0),
        (err) => {
          console.error(errorMessage(err));
          process.exit(1);
        },
      );
    });
  }
}

function printBanner(ctx: AppContext): void {
  const { config } = ctx;
  const urls = config.dev ? ["http://localhost:5173"] : consoleUrls(config.host, config.port);
  const token = currentSetupToken(ctx);
  const out: string[] = ["", `  ${pc.bold("agentinbox")} ${pc.dim(`v${config.version} · data in ${config.dataDir}`)}`, ""];
  if (token) {
    out.push(`  ${pc.yellow("First run:")} open this link to claim the instance and finish setup:`, "");
    for (const url of urls) out.push(`  ${pc.cyan(`${url}/setup?token=${token}`)}`);
  } else {
    out.push(`  ${pc.dim("Console")}  ${pc.cyan(urls[0]!)}`);
    for (const url of urls.slice(1)) out.push(`           ${pc.cyan(url)}`);
    out.push(`  ${pc.dim("MCP")}      ${pc.cyan(`${ctx.settings.publicUrl()}/mcp`)}`);
  }
  if (config.dev) out.push("", pc.dim(`  Dev mode: API on :${config.port}, console via Vite on :5173.`));
  console.log(out.join("\n") + "\n");
}

function openBrowser(url: string): void {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  try {
    open(url).then(
      (child) => child.on("error", () => {}),
      () => {},
    );
  } catch {
    // No browser available: the link is printed above.
  }
}
