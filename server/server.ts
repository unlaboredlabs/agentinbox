import { existsSync, rmdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import open from "open";
import pc from "picocolors";
import { createApp, hasMcp } from "./app.ts";
import { currentSetupToken } from "./auth/index.ts";
import { type Config, type ConfigInput, loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { acquireInstanceLock, assertMasterKeyUsable, cliCommand, type InstanceLock } from "./instance.ts";
import { startMaintenance } from "./maintenance.ts";
import { setupTokenPath } from "./auth/setup-token.ts";
import { consoleUrls, isPrivateIPv4, isWildcardHost, loopbackUrl, networkAddresses } from "./urls.ts";
import { errorMessage } from "./util/errors.ts";
import { createAppContext, type ServiceOverrides, startServices, stopServices } from "./wire.ts";

export interface StartOptions {
  config: Config;
  /** Replace services with fakes (tests). */
  overrides?: ServiceOverrides;
  /** Console build directory (defaults to dist/web). */
  webDir?: string;
  /** Called once the port is bound and the app is serving, before services start (prints the banner). */
  onReady?: (ctx: AppContext, info: { mcp: boolean }) => void;
}

export interface RunningServer {
  /** Base URL reachable from this machine, e.g. http://127.0.0.1:54321. */
  url: string;
  ctx: AppContext;
  server: ServerType;
  /** Stops accepting requests, stops services and closes the database. Idempotent. */
  close(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Binds the port first (so a busy port leaves nothing behind), then takes the data directory's
 * instance lock, checks the master key against stored secrets, builds the context and the app,
 * and finally starts services (so a second instance never runs ingest against the same data).
 * Use `port: 0` in tests; `config.port` is updated to the bound port.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  type Fetch = Parameters<typeof serve>[0]["fetch"];
  let handler: Fetch = () => new Response("agentinbox is starting", { status: 503, headers: { "retry-after": "1" } });
  let server: ServerType;
  try {
    server = await listen((req, env) => handler(req, env), config.host, config.port);
  } catch (err) {
    throw friendlyListenError(err, config.port);
  }
  config.port = (server.address() as AddressInfo).port;
  const closeServer = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      // SSE streams and long polls would otherwise hold the server open.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });

  let lock: InstanceLock;
  let ctx: AppContext;
  let mcp: boolean;
  try {
    lock = acquireInstanceLock(config);
    try {
      assertMasterKeyUsable(config);
      ctx = createAppContext(config, opts.overrides);
    } catch (err) {
      lock.release();
      throw err;
    }
    try {
      const app = createApp(ctx, { webDir: opts.webDir });
      mcp = hasMcp(app);
      handler = (req, env) => app.fetch(req, env);
    } catch (err) {
      ctx.db.close();
      lock.release();
      throw err;
    }
  } catch (err) {
    await closeServer();
    throw err;
  }
  opts.onReady?.(ctx, { mcp });

  let stopMaintenance = () => {};
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopMaintenance();
      await closeServer();
      await stopServices(ctx);
      lock.release();
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
  const dataDir = resolve(opts.dataDir ?? process.env.AGENTINBOX_DATA ?? join(homedir(), ".agentinbox"));
  const existed = existsSync(dataDir);
  const config = loadConfig(opts, opts.version);
  let running: RunningServer;
  try {
    running = await startServer({ config, onReady: (ctx, info) => printBanner(ctx, info) });
  } catch (err) {
    // Don't leave an empty data directory behind when we never got going (e.g. the port was busy).
    if (!existed) {
      try {
        rmdirSync(dataDir);
      } catch {
        // Not empty: keep it.
      }
    }
    throw err;
  }

  const token = currentSetupToken(running.ctx);
  if (token && opts.open && process.stdout.isTTY && !config.dev && !config.service) {
    openBrowser(`${consoleUrls(config.host, config.port)[0]}/setup?token=${token}`);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(pc.dim(`\n  Stopping agentinbox…`));
      setTimeout(() => {
        console.error(`agentinbox did not stop within ${SHUTDOWN_TIMEOUT_MS / 1000} s; exiting anyway.`);
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();
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

function printBanner(ctx: AppContext, info: { mcp: boolean }): void {
  const { config } = ctx;
  const urls = config.dev ? ["http://localhost:5173"] : consoleUrls(config.host, config.port);
  const token = currentSetupToken(ctx);
  const out: string[] = ["", `  ${pc.bold("agentinbox")} ${pc.dim(`v${config.version} · data in ${config.dataDir}`)}`, ""];
  if (token && config.service) {
    // Service logs are often readable by others (journal, log files): never print the token there.
    out.push(
      `  ${pc.yellow("Not claimed yet.")} Print the setup link with \`${cliCommand(`reset-password --data ${config.dataDir}`)}\`,`,
      `  or open ${urls[0]}/setup?token=<token> with the token from \`cat ${setupTokenPath(config.dataDir)}\`.`,
    );
  } else if (token) {
    out.push(`  ${pc.yellow("First run:")} open this link to claim the instance and finish setup:`, "");
    for (const url of urls) out.push(`  ${pc.cyan(`${url}/setup?token=${token}`)}`);
  } else {
    out.push(`  ${pc.dim("Console")}  ${pc.cyan(urls[0]!)}`);
    for (const url of urls.slice(1)) out.push(`           ${pc.cyan(url)}`);
    if (info.mcp) out.push(`  ${pc.dim("MCP")}      ${pc.cyan(`${ctx.settings.publicUrl()}/mcp`)}`);
  }
  const exposed = token && isWildcardHost(config.host) ? networkAddresses().filter((a) => !isPrivateIPv4(a)) : [];
  if (exposed.length) {
    out.push(
      "",
      `  ${pc.yellow("Heads up:")} port ${config.port} is reachable on the public address ${exposed.join(", ")}.`,
      `  Claim the instance now, or restart with --host 127.0.0.1 (or firewall the port) until you have.`,
    );
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
