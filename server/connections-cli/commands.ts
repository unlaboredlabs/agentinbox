import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { NPX } from "../listen/version.ts";

/**
 * `connections …` and `import --from …`: run on the daemon's machine, talking to its admin API through the
 * one-time local admin session (admin.ts). Hidden from --help while the broker is behind the `brokerUpstreams`
 * setting; the console PR that turns it on un-hides them (CONNECTIONS_VISIBLE).
 */
export const CONNECTIONS_VISIBLE = false;

const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];
const dataDirOf = (o: { data?: string }) => resolve(o.data ?? process.env.AGENTINBOX_DATA ?? join(homedir(), ".agentinbox"));
const dataOption = (cmd: Command) => cmd.option("-d, --data <dir>", "agentinbox's data directory (default ~/.agentinbox, env AGENTINBOX_DATA)");

async function withApi<T>(o: { data?: string; yes?: boolean }, run: (deps: { api: import("./api.ts").ConnectionsApi; prompter: import("./prompt.ts").Prompter }) => Promise<T>): Promise<T> {
  const { CLEANUP_SIGNALS, openAdminChannel } = await import("./admin.ts");
  const { ConnectionsApi } = await import("./api.ts");
  const { TerminalPrompter } = await import("./prompt.ts");
  const channel = openAdminChannel({ dataDir: dataDirOf(o) });
  const handlers = CLEANUP_SIGNALS.map((sig) => {
    const h = () => {
      channel.close();
      process.exit(sig === "SIGINT" ? 130 : 128 + (sig === "SIGTERM" ? 15 : 1));
    };
    process.once(sig, h);
    return [sig, h] as const;
  });
  try {
    return await run({ api: new ConnectionsApi(channel), prompter: new TerminalPrompter(!!o.yes) });
  } finally {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    channel.close();
  }
}

/** This agentinbox's own MCP origins, so `import` never imports its own entry. */
async function selfOrigins(dataDir: string): Promise<string[]> {
  const { runningInstance } = await import("../instance.ts");
  const { daemonOrigin } = await import("./admin.ts");
  const running = runningInstance(dataDir);
  if (!running) return [];
  return [daemonOrigin(running), `http://localhost:${running.port}`, `http://127.0.0.1:${running.port}`, `http://[::1]:${running.port}`];
}

export function registerConnectionsCommands(program: Command): void {
  const connections = program
    .command("connections", { hidden: !CONNECTIONS_VISIBLE })
    .description("the MCP servers agentinbox connects agents to (Notion, WHOOP, any MCP URL); run on agentinbox's machine")
    .summary("add, list, reconnect or remove connected MCP servers");

  dataOption(
    connections
      .command("add")
      .description("connect an integration (notion, whoop) or any MCP server URL, interactively")
      .argument("<integration-or-url>", "notion, whoop, or an MCP server URL such as https://mcp.example.com/mcp"),
  )
    .option("--slug <name>", "its name: agents see its tools as <name>__<tool>")
    .option("--access <level>", "full, ask (ask before risky actions; the default) or read")
    .option("--agent <name>", 'an agent that gets it (repeatable; default: all agents; "all")', collect)
    .option("--header <name>", "header for a server that wants a static key (default Authorization)")
    .option("--paste", "paste the address the browser lands on after signing in, instead of waiting for the redirect (automatic over SSH)")
    .option("--allow-private <origin>", "allow this exact scheme://host:port on this machine or a private network without asking (--yes never does)")
    .option("-y, --yes", "answer yes to confirmations and take the defaults (never to a private-network allow)")
    .addHelpText(
      "after",
      `
Examples:
  ${NPX} connections add notion
  ${NPX} connections add https://mcp.example.com/mcp --access read
  ${NPX} connections add http://127.0.0.1:8787/mcp      # asks before allowing a server on this machine`,
    )
    .action(async (target: string, o: import("./manage.ts").AddFlags & { data?: string }) => {
      const { addConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => addConnection(target, o, deps));
    });

  dataOption(connections.command("list").description("list connections with their status and access")).action(async (o: { data?: string }) => {
    const { listConnections } = await import("./manage.ts");
    process.exitCode = await withApi(o, (deps) => listConnections(deps));
  });

  dataOption(connections.command("reconnect").description("sign in again (OAuth) or replace the key (header)").argument("<name>", "the connection's name"))
    .option("--paste", "paste the address the browser lands on (automatic over SSH)")
    .option("--header <name>", "header connections: the header's name (default: asks, Authorization)")
    .action(async (slug: string, o: { data?: string; paste?: boolean; header?: string }) => {
      const { reconnectConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => reconnectConnection(slug, o, deps));
    });

  dataOption(connections.command("disable").description("turn a connection off at once (the kill switch); turn it back on in the console").argument("<name>", "the connection's name"))
    .option("-y, --yes", "don't ask")
    .action(async (slug: string, o: { data?: string; yes?: boolean }) => {
      const { disableConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => disableConnection(slug, deps));
    });

  dataOption(connections.command("remove").description("remove a connection and delete its credentials").argument("<name>", "the connection's name"))
    .option("-y, --yes", "don't ask")
    .action(async (slug: string, o: { data?: string; yes?: boolean }) => {
      const { removeConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => removeConnection(slug, deps));
    });

  dataOption(
    program
      .command("import", { hidden: !CONNECTIONS_VISIBLE })
      .description("move an agent tool's MCP servers into agentinbox: one connection each, credentials moved into agentinbox")
      .summary("import MCP servers from Hermes, Claude Code, Cursor or Codex")
      .requiredOption("--from <client>", "hermes, claude-code, cursor or codex"),
  )
    .option("--dry-run", "print exactly what would be created and changed, and change nothing")
    .option("--access <level>", "for every imported connection: full, ask (the default) or read")
    .option("--agent <name>", 'an agent that gets them (repeatable; default: all agents; "all")', collect)
    .option("--profile <name>", "the agent profile setup-mcp uses for the single agentinbox entry (default \"default\")")
    .option("--allow-private <origin>", "allow this exact scheme://host:port on this machine or a private network without asking (repeatable; --yes never does)", collect)
    .option("-y, --yes", "answer yes to the confirmations (scripts); never to a private-network allow or a project's .mcp.json servers")
    .addHelpText(
      "after",
      `
Reads: hermes ~/.hermes/config.yaml mcp_servers (+ ~/.hermes/.env) · claude-code ~/.claude.json and ./.mcp.json ·
cursor ~/.cursor/mcp.json · codex ~/.codex/config.toml. Static headers move into agentinbox (encrypted); OAuth
servers are created needing Connect (their tokens stay in the client); local (stdio) servers aren't supported yet
and stay where they are. Servers on this machine or a private network are created only after you confirm the exact
host:port. Then it offers setup-mcp --tool <client>, which replaces the entries that now work through agentinbox
with the single agentinbox entry, after a timestamped backup. Hermes keeps the "agentinbox" server name.

Examples:
  ${NPX} import --from hermes --dry-run
  ${NPX} import --from hermes`,
    )
    .action(async (o: import("./import.ts").ImportFlags & { data?: string }) => {
      const { runImport } = await import("./import.ts");
      const self = await selfOrigins(dataDirOf(o));
      if (o.dryRun) {
        const { TerminalPrompter } = await import("./prompt.ts");
        process.exitCode = await runImport(o, {
          prompter: new TerminalPrompter(!!o.yes),
          openApi: () => {
            throw new Error("dry run");
          },
          selfOrigins: self,
        });
        return;
      }
      process.exitCode = await withApi(o, (deps) => runImport(o, { prompter: deps.prompter, openApi: () => deps.api, selfOrigins: self }));
    });
}
