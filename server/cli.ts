// Must stay the first import: exits with a clear message on a too-old Node.
import "./node-check.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Command as CommandType } from "commander";

// Loaded after the Node check (static imports are hoisted above it in the bundle).
const { Command, InvalidArgumentError } = await import("commander");
const { default: pc } = await import("picocolors");

process.title = "agentinbox";

// node:sqlite is stable enough for us but still warns on Node 22. This runs before any server
// module loads: everything that touches node:sqlite is imported dynamically below.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if ((type === "ExperimentalWarning" || (warning as Error).name === "ExperimentalWarning") && /SQLite/i.test(message)) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

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

const validPort = (value: string) => /^\d+$/.test(value) && Number(value) <= 65535;

function parsePort(value: string): number {
  if (!validPort(value)) throw new InvalidArgumentError("Port must be a number from 0 to 65535.");
  return Number(value);
}

/** --port, else a validated PORT env (a typo there would otherwise become NaN deep inside). */
function portOption(flag: number | undefined): number | undefined {
  if (flag !== undefined) return flag;
  const env = process.env.PORT?.trim();
  if (!env) return undefined;
  if (!validPort(env)) throw new Error(`PORT="${process.env.PORT}" is not a valid port. Use a number from 0 to 65535.`);
  return Number(env);
}

const withServerOptions = (cmd: CommandType) =>
  cmd
    .option("-p, --port <port>", "port to listen on (default 8425, env PORT)", parsePort)
    .option("--host <host>", "bind address (default 0.0.0.0, env HOST)")
    .option("-d, --data <dir>", "data directory (default ~/.agentinbox, env AGENTINBOX_DATA)");

const configInput = (o: ServerFlags) => ({ port: portOption(o.port), host: o.host, dataDir: o.data });

const program = new Command("agentinbox")
  .description("Self-hosted Gmail broker for AI agents: MCP tools, webhooks, guardrails and a web console.")
  .version(version, "-v, --version", "print the version")
  .helpOption("-h, --help", "show help")
  .addHelpText("after", "\nWithout installing: npx agentinbox-cli [command]. To install the command: npm i -g agentinbox-cli")
  .showSuggestionAfterError();

withServerOptions(program.command("start", { isDefault: true }).description("run agentinbox in the foreground (default)"))
  .option("--no-open", "don't open a browser on first run")
  .option("--dev", "development: API only, the console runs on Vite (:5173)")
  // `agentinbox typo` lands here as an extra argument: report it as the unknown command it is.
  .allowExcessArguments()
  .action(async (o: ServerFlags & { open: boolean; dev?: boolean }, cmd: CommandType) => {
    if (cmd.args.length) throw new Error(unknownCommand(cmd.args[0]!));
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
    process.stdout.write(renderSkill(await serverUrl(o.url)));
  });

skill
  .command("install")
  .description("install SKILL.md for an agent (no running server needed)")
  .option("-t, --target <target>", "claude, codex, agents, or a skills directory path", "claude")
  .option("--url <url>", "agentinbox server URL agents connect to (env AGENTINBOX_URL)")
  .action(async (o: { target: string; url?: string }) => {
    const { renderSkill, SKILL_TARGETS, skillPath, writeSkill } = await import("./skill/index.ts");
    checkSkillTarget(o.target, Object.keys(SKILL_TARGETS));
    const url = await serverUrl(o.url);
    const path = skillPath(o.target);
    writeSkill(path, renderSkill(url));
    console.log(`Installed the agentinbox skill to ${pc.cyan(path)} (server ${url}).`);
    if (!o.url && !process.env.AGENTINBOX_URL) {
      console.log(pc.dim("Agents on other machines need the server's address: re-run with --url https://your-server."));
    }
  });

program
  .command("reset-password")
  .description("remove the admin password and print a new setup link")
  .option("-d, --data <dir>", "data directory (default ~/.agentinbox, env AGENTINBOX_DATA)")
  .option("-p, --port <port>", "port of the running instance, used for the printed link", parsePort)
  .option("--host <host>", "host of the running instance, used for the printed link")
  .action(
  async (o: ServerFlags) => {
    // Never create a data directory or master key here: a wrong --data (or a service running as
    // another user) must not silently produce a fresh instance.
    const dataDir = resolve(o.data ?? process.env.AGENTINBOX_DATA ?? join(homedir(), ".agentinbox"));
    const dbPath = join(dataDir, "agentinbox.db");
    if (!existsSync(dbPath)) {
      throw new Error(
        `No agentinbox data in ${dataDir}. If agentinbox runs as a system service, run this with sudo; ` +
          "otherwise pass the data directory it uses with --data.",
      );
    }
    const { loadConfig } = await import("./config.ts");
    const { Db } = await import("./db/index.ts");
    const { createBus } = await import("./bus.ts");
    const { SettingsStore } = await import("./settings.ts");
    const { AuditLog } = await import("./audit.ts");
    const { currentSetupToken, isClaimed, resetAdminPassword } = await import("./auth/index.ts");
    const { runningInstance } = await import("./instance.ts");
    const { consoleUrls } = await import("./urls.ts");

    const running = runningInstance(dataDir);
    const config = loadConfig(
      { dataDir, port: portOption(o.port) ?? running?.port, host: o.host ?? (process.env.HOST || running?.host) },
      version,
    );
    const db = new Db(dbPath);
    try {
      const bus = createBus();
      const core = { config, db, settings: new SettingsStore(db, bus, config), audit: new AuditLog(db, bus) };
      const claimed = isClaimed(core);
      const token = claimed ? resetAdminPassword(core) : currentSetupToken(core)!;
      console.log(
        claimed
          ? "\n  The admin password was removed and all console sessions were signed out.\n  Open this link to set a new password:\n"
          : "\n  This instance hasn't been claimed yet, so there is no password to reset.\n  Open this link to claim it:\n",
      );
      const urls = consoleUrls(config.host, config.port);
      const publicUrl = core.settings.publicUrl();
      if (!urls.includes(publicUrl)) urls.push(publicUrl);
      for (const url of urls) console.log(`  ${pc.cyan(`${url}/setup?token=${token}`)}`);
      console.log(pc.dim(`\n  ${running ? "The running agentinbox picks this up immediately; no restart needed." : "Start agentinbox to use it."}\n`));
    } finally {
      db.close();
    }
  },
);

/**
 * The URL written into SKILL.md: --url, AGENTINBOX_URL, else the agentinbox running on this
 * machine (its lock file), else http://localhost:8425.
 */
async function serverUrl(flag: string | undefined): Promise<string> {
  let raw = flag ?? process.env.AGENTINBOX_URL;
  if (!raw) {
    const { runningInstance } = await import("./instance.ts");
    const running = runningInstance(resolve(process.env.AGENTINBOX_DATA || join(homedir(), ".agentinbox")));
    const host = running && !["0.0.0.0", "::", ""].includes(running.host) ? running.host : "localhost";
    raw = `http://${host.includes(":") ? `[${host}]` : host}:${running?.port || process.env.PORT || 8425}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --url "${raw}". Use a full URL such as https://mail.example.com.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must start with http:// or https://");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/** A known agent name, or something that is clearly a path; typos like "claud" are refused. */
function checkSkillTarget(target: string, known: string[]): void {
  if (known.includes(target) || target.includes("/") || target.includes(sep) || target.startsWith(".") || isDir(target)) return;
  const near = closest(target, known);
  throw new Error(
    `Unknown skill target "${target}".${near ? ` Did you mean ${near}?` : ""} Use ${known.join(", ")}, or a directory path such as ./skills.`,
  );
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const COMMANDS = ["start", "service", "skill", "reset-password", "help"];

function unknownCommand(name: string): string {
  const near = closest(name, COMMANDS);
  return `unknown command '${name}'${near ? `\n(Did you mean ${near}?)` : ""}\nRun agentinbox --help for the list of commands.`;
}

/** The candidate within edit distance 2 (or a prefix match), if any. */
function closest(word: string, candidates: string[]): string | null {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[b.length]!;
  };
  let best: { name: string; d: number } | null = null;
  for (const c of candidates) {
    const d = c.startsWith(word) && word.length >= 3 ? 0 : distance(word.toLowerCase(), c);
    if (d <= 2 && (!best || d < best.d)) best = { name: c, d };
  }
  return best?.name ?? null;
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  if (process.env.AGENTINBOX_DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
}
