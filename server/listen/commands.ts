import { type Command, InvalidArgumentError } from "commander";
import { EVENT_TYPES } from "../../shared/types.ts";
import type { ConnectFlags } from "./connect.ts";
import type { ListenFlags } from "./options.ts";
import { DEFAULT_PROFILE } from "./paths.ts";
import { recipesHelp, TOOLS } from "./recipes.ts";
import { NPX } from "./version.ts";

/** `agentinbox connect`, `agentinbox setup-mcp` and `agentinbox listen …`, all lazily loaded. */

/**
 * Options of a `listen` subcommand plus any its ancestors parsed: `listen` declares the same flags
 * (--profile, --exec…), and commander lets the parent claim them wherever they appear.
 */
const all = <T>(cmd: Command): T => cmd.optsWithGlobals() as T;

const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];

const int = (name: string) => (value: string) => {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError(`${name} must be a whole number.`);
  return Number(value);
};

const profileOption = (cmd: Command) => cmd.option("--profile <name>", `profile to use (default "${DEFAULT_PROFILE}")`);

function listenFlags(cmd: Command): Command {
  return profileOption(cmd)
    .option("--exec <command>", "run this command for each event (via /bin/sh; the event arrives on stdin as JSON, never in the command)")
    .option("--forward <url>", "POST each event to this localhost URL, signed per Standard Webhooks")
    .option("--types <list>", `comma-separated event types (${EVENT_TYPES.join(", ")})`)
    .option("--from <glob>", 'only senders matching this glob, e.g. "*@stripe.com" (repeatable)', collect)
    .option("--to <glob>", "only when a to/cc address matches (repeatable)", collect)
    .option("--label <id>", "only messages with this Gmail label id, e.g. INBOX or Label_123 (repeatable)", collect)
    .option("--subject <regex>", "only subjects matching this case-insensitive regular expression")
    .option("--include-body", "include the cleaned message body in each event")
    .option("--no-include-body", "don't include bodies (overrides a saved setting)")
    .option("--concurrency <n>", "events handled at once (default 2)", int("--concurrency"))
    .option("--timeout <seconds>", "per-event time limit; the whole process group is killed after it (default 300)", int("--timeout"))
    .option("--max-attempts <n>", "attempts before an event goes to dead letters (default 5)", int("--max-attempts"))
    .option("--consumer <name>", "server-side cursor name (default <hostname>-<profile>)")
    .option("--cwd <dir>", "directory --exec commands run in (default: a private dir in the state dir; must be yours and not group/world-writable)")
    .option("--insecure", "allow plain http to a non-loopback, non-Tailscale daemon (loud warning)")
    .option("--save", "save these settings to the profile");
}

export function registerListenCommands(program: Command): void {
  program
    .command("connect")
    .description("pair this machine's agent with an agentinbox daemon (approve the code in the console)")
    .argument("<daemon-url>", "the agentinbox daemon, e.g. https://mail.example.com or http://100.101.102.103:8425")
    .option("--name <name>", 'how the agent appears in the console (default "<Tool> on <hostname>")')
    .option("--tool <tool>", `the agent's tool: ${TOOLS.join(", ")}; tailors the next steps`)
    .option("--account <email>", "mailbox to request access to (repeatable; the approver decides)", collect)
    .option("--capabilities <list>", "capabilities to request, e.g. read,draft (the approver decides)")
    .option("--reason <text>", "why the agent needs access (shown to the approver)")
    .option("--setup-mcp", "also register the MCP server in the chosen tool (the key is never shown)")
    .option("--profile <name>", `profile to save the key in (default "${DEFAULT_PROFILE}")`)
    .option("--consumer <name>", "listener cursor name (default <hostname>-<profile>)")
    .option("--insecure", "allow plain http to a non-loopback, non-Tailscale daemon (loud warning)")
    .option("--force", "replace an existing profile")
    .addHelpText(
      "after",
      `
Exit codes: 0 approved, 2 denied, 3 expired, 4 already consumed, 130 cancelled, 1 error.

Example:
  ${NPX} connect https://mail.example.com --tool claude-code --setup-mcp`,
    )
    .action(async (url: string, flags: ConnectFlags) => {
      const { runConnect } = await import("./connect.ts");
      process.exit(await runConnect(url, flags, { handleSignals: true }));
    });

  profileOption(program.command("setup-mcp").description("register the agentinbox MCP server in your agent's tool, without showing the key"))
    .option("--tool <tool>", `${TOOLS.filter((t) => t !== "other").join(", ")} (default: the tool given to connect)`)
    .action(async (flags: { tool?: string; profile?: string }) => {
      const { parseTool, printMcpResult } = await import("./connect.ts");
      const { loadProfile } = await import("./profile.ts");
      const { setupMcp, mcpTarget } = await import("./mcpsetup.ts");
      const { profilePath } = await import("./paths.ts");
      const name = flags.profile ?? DEFAULT_PROFILE;
      const profile = loadProfile(name);
      const tool = flags.tool ? parseTool(flags.tool) : (profile.tool ?? "other");
      if (tool === "other") throw new Error(`Which tool? Pass --tool ${TOOLS.filter((t) => t !== "other").join("|")}.`);
      const { writeClaudeMcpConfig } = await import("./mcpheader.ts");
      writeClaudeMcpConfig(name, `${profile.url}/mcp`);
      const r = setupMcp(tool, mcpTarget(name, profile), profilePath(name));
      printMcpResult(r);
      if (!r.ok) process.exitCode = 1;
    });

  profileOption(
    program.command("mcp-header").description("print the agent's Authorization header as JSON for an MCP client's header helper (refuses to print to a terminal)"),
  ).action(async (flags: { profile?: string }) => {
    const { printMcpHeader } = await import("./mcpheader.ts");
    process.exitCode = printMcpHeader(flags.profile ?? DEFAULT_PROFILE);
  });

  const listen = listenFlags(
    program
      .command("listen")
      .description("wake a local agent on new mail: hold an outbound stream to the daemon and run a command or POST to localhost per event"),
  )
    .option("--dry-run", "print matching events without running anything or advancing the cursor")
    .option("--from-start", "first run of a consumer: also process events stored before now (default: only new ones)")
    .addHelpText("after", recipesHelp())
    .action(async (flags: ListenFlags) => {
      const { runListener } = await import("./listen.ts");
      process.exit(await runListener({ flags, handleSignals: true }));
    });

  profileOption(listen.command("status").description("show the listener's connection, cursor, recent events and dead letters")).action(async (_o: unknown, cmd: Command) => {
    const flags = all<{ profile?: string }>(cmd);
    const { printStatus } = await import("./admin.ts");
    await printStatus(flags.profile ?? DEFAULT_PROFILE);
  });

  profileOption(listen.command("secret").description("print the forward-mode signing secret (whsec_…) for your local receiver"))
    .option("--rotate", "generate a new secret (restart the listener afterwards)")
    .action(async (_o: unknown, cmd: Command) => {
      const flags = all<{ profile?: string; rotate?: boolean }>(cmd);
      const { printSecret } = await import("./admin.ts");
      printSecret(flags.profile ?? DEFAULT_PROFILE, flags);
    });

  listenFlags(listen.command("dead").description("list events that failed every attempt; --replay runs them again"))
    .option("--replay", "run dead events again (successes are removed)")
    .option("--id <eventId>", "only this event (with --replay or --clear)")
    .option("--clear", "delete dead events without running them")
    .option("--json", "print raw JSON lines")
    .action(async (_o: unknown, cmd: Command) => {
      const flags = all<ListenFlags & { replay?: boolean; id?: string; clear?: boolean; json?: boolean }>(cmd);
      const admin = await import("./admin.ts");
      const profile = flags.profile ?? DEFAULT_PROFILE;
      if (flags.clear) admin.clearDead(profile, flags.id);
      else if (flags.replay) {
        if ((await admin.replayDead(flags)) > 0) process.exitCode = 1;
      } else admin.printDead(profile, flags);
    });

  const service = listen.command("service").description("run the listener in the background (systemd user service / launchd agent, one per profile)");
  listenFlags(service.command("install").description("install and start the listener service; flags are saved to the profile. Re-run to update")).action(
    async (_o: unknown, cmd: Command) => {
      const flags = all<ListenFlags>(cmd);
      const { installListenService } = await import("./service.ts");
      await installListenService(flags);
    },
  );
  profileOption(service.command("uninstall").description("stop and remove the listener service (keeps the profile)")).action(async (_o: unknown, cmd: Command) => {
    const flags = all<{ profile?: string }>(cmd);
    const { uninstallListenService } = await import("./service.ts");
    uninstallListenService(flags.profile ?? DEFAULT_PROFILE);
  });
  profileOption(service.command("status").description("show the service manager's status for the listener")).action(async (_o: unknown, cmd: Command) => {
    const flags = all<{ profile?: string }>(cmd);
    const { listenServiceStatus } = await import("./service.ts");
    listenServiceStatus(flags.profile ?? DEFAULT_PROFILE);
  });
}
