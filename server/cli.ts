import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";

/** package.json sits one level above both dist/cli.js and server/cli.ts. */
function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

const version = packageVersion();

interface ServerFlags {
  port?: number;
  host?: string;
  data?: string;
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 0 || n > 65535) throw new InvalidArgumentError("Port must be a number from 0 to 65535.");
  return n;
}

const withServerOptions = (cmd: Command) =>
  cmd
    .option("-p, --port <port>", "port to listen on (default 8425, env PORT)", parsePort)
    .option("--host <host>", "bind address (default 0.0.0.0, env HOST)")
    .option("-d, --data <dir>", "data directory (default ~/.agentinbox, env AGENTINBOX_DATA)");

const configInput = (o: ServerFlags) => ({ port: o.port, host: o.host, dataDir: o.data });

const program = new Command("agentinbox")
  .description("Self-hosted Gmail broker for AI agents: MCP tools, webhooks, guardrails and a web console.")
  .version(version, "-v, --version", "print the version")
  .helpOption("-h, --help", "show help")
  .showSuggestionAfterError();

withServerOptions(program.command("start", { isDefault: true }).description("run agentinbox in the foreground (default)"))
  .option("--no-open", "don't open a browser on first run")
  .option("--dev", "development: API only, the console runs on Vite (:5173)")
  .action(async (o: ServerFlags & { open: boolean; dev?: boolean }) => {
    const { runForeground } = await import("./server.ts");
    await runForeground({ ...configInput(o), dev: !!o.dev, open: o.open, version });
  });

const service = program.command("service").description("run agentinbox as a background service (systemd / launchd)");

withServerOptions(service.command("install").description("install and start the service; re-run to update")).action(async (o: ServerFlags) => {
  const { loadConfig } = await import("./config.ts");
  const { installService } = await import("./service.ts");
  await installService(loadConfig(configInput(o), version));
});

service
  .command("uninstall")
  .description("stop and remove the service (keeps your data)")
  .option("-d, --data <dir>", "data directory (default ~/.agentinbox, env AGENTINBOX_DATA)")
  .action(async (o: ServerFlags) => {
    const { loadConfig } = await import("./config.ts");
    const { uninstallService } = await import("./service.ts");
    uninstallService(loadConfig(configInput(o), version));
  });

service
  .command("status")
  .description("show service status")
  .action(async () => {
    const { serviceStatus } = await import("./service.ts");
    serviceStatus();
  });

const skill = program.command("skill").description("the agentinbox agent skill (SKILL.md)");

skill
  .command("print")
  .description("print SKILL.md to stdout")
  .option("--url <url>", "agentinbox server URL to fill in (env AGENTINBOX_URL)")
  .action(async (o: { url?: string }) => {
    const { renderSkill } = await import("./skill/index.ts");
    process.stdout.write(renderSkill(serverUrl(o.url)));
  });

skill
  .command("install")
  .description("install SKILL.md for an agent (no running server needed)")
  .option("-t, --target <target>", "claude, codex, agents, or a skills directory", "claude")
  .option("--url <url>", "agentinbox server URL agents connect to (env AGENTINBOX_URL)")
  .action(async (o: { target: string; url?: string }) => {
    const { renderSkill, skillPath, writeSkill } = await import("./skill/index.ts");
    const url = serverUrl(o.url);
    const path = skillPath(o.target);
    writeSkill(path, renderSkill(url));
    console.log(`Installed the agentinbox skill to ${pc.cyan(path)} (server ${url}).`);
    if (!o.url && !process.env.AGENTINBOX_URL) {
      console.log(pc.dim("Agents on other machines need the server's address: re-run with --url https://your-server."));
    }
  });

withServerOptions(program.command("reset-password").description("remove the admin password and print a new setup link")).action(
  async (o: ServerFlags) => {
    const { loadConfig } = await import("./config.ts");
    const { createCore } = await import("./context.ts");
    const { resetAdminPassword } = await import("./auth/index.ts");
    const { consoleUrls } = await import("./urls.ts");
    const config = loadConfig(configInput(o), version);
    const core = createCore(config);
    try {
      const token = resetAdminPassword(core);
      console.log("\n  The admin password was removed and all console sessions were signed out.");
      console.log("  Open this link to set a new password:\n");
      for (const url of consoleUrls(config.host, config.port)) console.log(`  ${pc.cyan(`${url}/setup?token=${token}`)}`);
      console.log(pc.dim("\n  A running agentinbox picks this up immediately; no restart needed.\n"));
    } finally {
      core.db.close();
    }
  },
);

/** The URL written into SKILL.md: --url, AGENTINBOX_URL, or this machine's default. */
function serverUrl(flag: string | undefined): string {
  const raw = flag ?? process.env.AGENTINBOX_URL ?? `http://localhost:${process.env.PORT || 8425}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --url "${raw}". Use a full URL such as https://mail.example.com.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must start with http:// or https://");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  if (process.env.AGENTINBOX_DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
}
