import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { forwardSecret } from "./options.ts";
import { DEFAULT_PROFILE, validProfileName } from "./paths.ts";
import { loadProfile, saveProfile } from "./profile.ts";
import { HERMES_ROUTE_PROMPT, hermesGatewayBase, hermesRoute, hermesRouteToolset, mcpServerName, shellQuote } from "./recipes.ts";
import { NPX, version } from "./version.ts";

/**
 * `agentinbox listen hermes`: the Hermes gateway webhook route `--recipe hermes` forwards to, created with
 * `hermes webhook subscribe` (Hermes Agent, NousResearch/hermes-agent). Facts this relies on, from Hermes'
 * docs (user-guide/messaging/webhooks) and source (hermes_cli/webhook.py, gateway/platforms/webhook.py,
 * gateway/run_turn.py, hermes_cli/tools_config.py, cron/scheduler.py):
 * - routes live at /webhooks/<name> on port 8644; Standard Webhooks signatures are verified, with a whsec_
 *   secret base64-decoded like ours; `--secret` is only an argument (no env var, file or stdin), and
 *   `subscribe` prints it back;
 * - a route's agent run gets the `hermes-webhook` toolset (web_search, web_extract, vision_analyze,
 *   clarify) plus every MCP server enabled in Hermes, unless the route has a `toolsets` list. `subscribe`
 *   can't set that (by design) and replaces the whole route; it lives in
 *   <HERMES_HOME>/webhook_subscriptions.json (0600, written under .webhook_subscriptions.lock by flock and
 *   atomic rename; the gateway reloads it when the file changes). `["mcp-<server>"]` resolves through
 *   `_get_platform_tools` to that one MCP server and no built-in toolsets;
 * - a cron job's own `enabled_toolsets` decides its tools; there `mcp-<server>` does NOT narrow the MCP
 *   servers (every enabled server is added unless a bare server name is listed), so only `["<server>"]`
 *   confines it.
 */

export interface HermesFlags {
  profile?: string;
  deliver?: string;
  deliverChatId?: string;
  cronJob?: string;
  script?: string;
  run?: boolean;
}

const out = (s = "") => process.stdout.write(`${s}\n`);

/** Hermes' home: $HERMES_HOME, else ~/.hermes (plus HERMES_DATA_DIR_SUFFIX), as hermes_constants.py does. */
export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.HERMES_HOME?.trim();
  if (set) return set.replace(/^~(?=\/|$)/, homedir());
  return join(homedir(), `.hermes${env.HERMES_DATA_DIR_SUFFIX ?? ""}`);
}
export const subscriptionsPath = () => join(hermesHome(), "webhook_subscriptions.json");

/** The argv for `hermes …`. */
export function subscribeArgs(profileName: string, flags: HermesFlags, secret: string): string[] {
  if (!!flags.deliver === !!flags.cronJob) {
    throw new Error(
      "Where should Hermes tell you about important mail? Pass one of:\n" +
        "  --deliver <telegram|discord|slack|…>   a platform connected to your Hermes gateway (--deliver-chat-id <id> for a specific chat; --deliver log keeps it in the gateway log)\n" +
        `  --cron-job <job>                       an existing Hermes cron job (id or name, see \`hermes cron list\`) whose enabled_toolsets is exactly ["${mcpServerName(profileName)}"]; its prompt and delivery apply`,
    );
  }
  if (flags.deliverChatId && !flags.deliver) throw new Error("--deliver-chat-id goes with --deliver.");
  if (flags.deliver && !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(flags.deliver)) throw new Error(`--deliver takes a platform name such as telegram, not "${flags.deliver}".`);
  const args = ["webhook", "subscribe", hermesRoute(profileName), "--secret", secret, "--prompt", HERMES_ROUTE_PROMPT, "--description", `agentinbox listener (profile ${profileName})`];
  if (flags.deliver) args.push("--deliver", flags.deliver);
  // = form: chat ids such as Telegram's -100… must not look like an option.
  if (flags.deliverChatId) args.push(`--deliver-chat-id=${flags.deliverChatId}`);
  if (flags.cronJob) args.push(`--cron-job=${flags.cronJob}`);
  if (flags.script) args.push(`--script=${flags.script}`);
  return args;
}

/**
 * A cron job gets the email with its OWN toolset, which may include a shell. Only a job limited to the
 * agentinbox MCP server (enabled_toolsets naming exactly the bare server name) is accepted.
 */
export function checkCronJob(ref: string, profileName: string, file = join(hermesHome(), "cron", "jobs.json")): void {
  const server = mcpServerName(profileName);
  const fix =
    `Limit the job to agentinbox first: ask Hermes to update cron job "${ref}" with enabled_toolsets ["${server}"] (its cronjob tool), ` +
    `then run this again. Or use --deliver instead. (In a cron job, "mcp-${server}" alone doesn't narrow anything: Hermes then adds every MCP server.)`;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`Couldn't read Hermes' cron jobs (${file}: ${(err as Error).message.split("\n")[0]}), so the job's tools can't be checked. A cron job runs the email with its own tools, which may include a shell.\n  ${fix}`);
  }
  const jobs = (Array.isArray(data) ? data : ((data as { jobs?: unknown })?.jobs ?? [])) as { id?: string; name?: string; enabled_toolsets?: unknown }[];
  const byId = jobs.find((j) => j.id === ref);
  const byName = jobs.filter((j) => (j.name ?? "").toLowerCase() === ref.toLowerCase());
  if (!byId && byName.length > 1) throw new Error(`Several Hermes cron jobs are named "${ref}": pass the job id (hermes cron list).`);
  const job = byId ?? byName[0];
  if (!job) throw new Error(`No Hermes cron job "${ref}" in ${file} (hermes cron list shows them).`);
  const ts = job.enabled_toolsets;
  const ok = Array.isArray(ts) && ts.includes(server) && ts.every((t) => t === server || t === `mcp-${server}`);
  if (!ok) {
    throw new Error(
      `Hermes cron job "${ref}" isn't limited to agentinbox (enabled_toolsets: ${JSON.stringify(ts ?? null)}). ` +
        `Email would run with that job's tools (possibly a shell, web and your other MCP servers), and anyone can send email.\n  ${fix}`,
    );
  }
}

async function gatewayHealthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Under Hermes' own lock (.webhook_subscriptions.lock, flock): checks the route still has the throwaway
 * secret `hermes webhook subscribe` was given, then sets the listener's real secret and the route's
 * toolsets in one atomic, 0600 write. The real secret comes in on stdin, never in argv. Python because
 * Hermes needs it anyway and Node has no flock.
 */
const CONFINE_PY = `
import fcntl, json, os, sys, tempfile
path, lock, name, toolset = sys.argv[1:5]
inp = json.load(sys.stdin)
os.makedirs(os.path.dirname(lock), exist_ok=True)
with open(lock, "a+b") as lf:
    fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
    with open(path, "r", encoding="utf-8-sig") as f:
        subs = json.load(f)
    route = subs.get(name) if isinstance(subs, dict) else None
    if not isinstance(route, dict):
        sys.exit("route %s is missing from %s" % (name, path))
    if route.get("secret") != inp["throwaway"]:
        sys.exit("route %s changed since hermes created it; run this again" % name)
    route["secret"] = inp["secret"]
    route["toolsets"] = [toolset]
    fd, tmp = tempfile.mkstemp(prefix=".webhook_subscriptions_", dir=os.path.dirname(path))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(subs, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
`;

/** Re-reads the subscriptions file: the route must have the real secret, exactly our toolsets, and the file must be 0600. */
export function verifyRoute(profileName: string, secret: string, file = subscriptionsPath()): string | null {
  try {
    if ((statSync(file).mode & 0o077) !== 0) return `${file} is readable by other users`;
    const route = (JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, { secret?: string; toolsets?: unknown }>)[hermesRoute(profileName)];
    if (!route) return `route ${hermesRoute(profileName)} is missing`;
    if (route.secret !== secret) return "the route's secret isn't the listener's";
    if (JSON.stringify(route.toolsets) !== JSON.stringify([hermesRouteToolset(profileName)])) return `the route's toolsets are ${JSON.stringify(route.toolsets ?? null)}`;
    return null;
  } catch (err) {
    return (err as Error).message.split("\n")[0]!;
  }
}

export interface HermesDeps {
  /** Runs hermes and python3 (tests). */
  spawn?: typeof spawnSync;
}

export async function hermesSubscribe(profileArg: string, flags: HermesFlags, deps: HermesDeps = {}): Promise<number> {
  const profileName = validProfileName(profileArg);
  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  const profile = loadProfile(profileName);
  // Validates the flags (and a cron job's tools) before a secret is generated or anything runs.
  subscribeArgs(profileName, flags, "");
  if (flags.cronJob) checkCronJob(flags.cronJob, profileName);
  const { secret, created } = forwardSecret(profile);
  if (created) {
    // Same as `listen secret`: generated once and kept, so the listener and Hermes agree from now on.
    profile.forwardSecret = secret;
    saveProfile(profileName, profile);
  }
  const base = hermesGatewayBase(profileName, profile.forward?.url);
  const route = `${base}/webhooks/${hermesRoute(profileName)}`;
  const forwardsThere = profile.forward?.url === route;
  const toolset = hermesRouteToolset(profileName);
  const file = subscriptionsPath();

  if (!flags.run) {
    const npx = `npx -y agentinbox-cli@${version}`;
    const shown = subscribeArgs(profileName, flags, "SECRET").map((a) => (a === "SECRET" ? `"$S"` : shellQuote(a)));
    out(`Hermes route for profile "${profileName}": ${route}`);
    out();
    out(`Set it up with (recommended; it also limits the route to the agentinbox tools, see step 2):`);
    out(`  ${pc.cyan(`${NPX} listen hermes${p} ${flagsText(flags)} --run`)}`);
    out();
    out(pc.gray("Or by hand, in two steps. 1. Create the route; the secret is read from the profile as it runs (stops if that fails),"));
    out(pc.gray("so it isn't typed or kept in your shell history. hermes prints it back once as Secret: …"));
    out(`  S=$(${npx} listen secret${p}) && hermes ${shown.join(" ")}`);
    out();
    out(`2. ${pc.bold("REQUIRED:")} in ${file}, add this to the "${hermesRoute(profileName)}" entry (the gateway reloads the file by itself):`);
    out(`  "toolsets": ["${toolset}"]`);
    out(
      pc.yellow(
        `  Until you do, every email-triggered run on this route has Hermes' web tools (web_search, web_extract, vision_analyze, clarify) and ALL your MCP servers: an email could make it read your mail and send it to any website. Running \`hermes webhook subscribe\` again for this route removes the line.`,
      ),
    );
    printNext(forwardsThere, p);
    return 0;
  }

  const spawn = deps.spawn ?? spawnSync;
  // hermes only takes the secret as an argument (visible in `ps`) and serves the route as soon as it is
  // saved. So it gets a throwaway secret: requests fail (401, retried) until the locked edit below sets the
  // real secret together with the toolsets. The real secret is never in argv, and the route never runs unconfined.
  const throwaway = `agentinbox-pending-${randomBytes(18).toString("base64url")}`;
  const run = spawn("hermes", subscribeArgs(profileName, flags, throwaway), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const redact = (t: string | null | undefined) => (t ?? "").split(throwaway).join("(set by agentinbox next)").split(secret).join("whsec_…(hidden)");
  if (run.error) {
    const missing = (run.error as NodeJS.ErrnoException).code === "ENOENT";
    throw new Error(missing ? "hermes isn't on your PATH. Install Hermes Agent (https://hermes-agent.nousresearch.com), or run this where `hermes` works." : `Couldn't run hermes: ${redact(run.error.message)}`);
  }
  const text = `${redact(run.stdout)}${redact(run.stderr)}`.trim();
  if (text) out(text.split("\n").map((l) => `  ${pc.gray("hermes │")} ${l}`).join("\n"));
  // hermes prints "Error: …" (or its setup hint) and still exits 0, so success is the line it prints on success.
  if (run.status !== 0 || !/(Created|Updated) webhook subscription/.test(run.stdout ?? "")) {
    out();
    out(pc.red(`✖ hermes didn't create the route${run.status ? ` (exit ${run.status})` : ""}.`));
    if (/not enabled/i.test(text)) out(`  Turn on the gateway's webhook platform first: hermes gateway setup (or WEBHOOK_ENABLED=true in ~/.hermes/.env), then run this again.`);
    return 1;
  }

  const lock = join(dirname(file), ".webhook_subscriptions.lock");
  const py = spawn("python3", ["-I", "-c", CONFINE_PY, file, lock, hermesRoute(profileName), toolset], {
    encoding: "utf8",
    input: JSON.stringify({ secret, throwaway }),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
  const problem = py.error ? `python3: ${py.error.message}` : py.status !== 0 ? redact(`${py.stderr ?? ""}`.trim().split("\n").at(-1)) || `python3 exited ${py.status}` : verifyRoute(profileName, secret, file);
  if (problem) {
    out();
    out(pc.red(`✖ Couldn't limit the Hermes route to the agentinbox tools: ${problem}.`));
    out(`  The route still has a placeholder secret, so Hermes refuses the listener's requests (they're retried, nothing runs). Fix the cause and run this again.`);
    return 1;
  }
  out();
  out(`${pc.green("✔")} Hermes route ${hermesRoute(profileName)} is set up with this listener's secret, limited to the toolset ${toolset} (no web or other tools, no other MCP servers).`);
  out(pc.gray(`  Running \`hermes webhook subscribe ${hermesRoute(profileName)}\` yourself later resets that; run this command again afterwards.`));
  if (await gatewayHealthy(base)) out(`  The Hermes gateway answers at ${base}.`);
  else out(pc.yellow(`  The Hermes gateway isn't answering at ${base}/health: start it (hermes gateway), or if it uses another port, forward there with --forward <its URL>/webhooks/${hermesRoute(profileName)}.`));
  printNext(forwardsThere, p);
  return 0;
}

/** Probes the gateway a Hermes forward goes to; a warning line when it doesn't answer, else null. */
export async function gatewayWarning(forwardUrl: string): Promise<string | null> {
  const base = new URL(forwardUrl).origin;
  return (await gatewayHealthy(base)) ? null : `The Hermes gateway isn't answering at ${base}/health. Events wait and are retried until it does: start it (hermes gateway).`;
}

function flagsText(f: HermesFlags): string {
  const parts: string[] = [];
  if (f.deliver) parts.push(`--deliver ${shellQuote(f.deliver)}`);
  if (f.deliverChatId) parts.push(`--deliver-chat-id=${shellQuote(f.deliverChatId)}`);
  if (f.cronJob) parts.push(`--cron-job ${shellQuote(f.cronJob)}`);
  if (f.script) parts.push(`--script ${shellQuote(f.script)}`);
  return parts.join(" ");
}

function printNext(forwardsThere: boolean, p: string): void {
  out();
  if (forwardsThere) {
    out(`The listener already forwards there. Restart it (or \`${NPX} listen service install${p}\`) if the route is new.`);
    return;
  }
  out("Then point the listener at it and keep it running:");
  out(`  ${pc.cyan(`${NPX} listen${p} --save --recipe hermes`)}   ${pc.gray("(try it in the foreground; Ctrl-C stops it)")}`);
  out(`  ${pc.cyan(`${NPX} listen service install${p} --recipe hermes`)}`);
}
