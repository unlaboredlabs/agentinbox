import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { hermesHome, yamlMcpServerState } from "./mcpsetup.ts";
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
 *   `_get_platform_tools` to that one MCP server and no built-in toolsets, but only when <server> is an
 *   enabled MCP server in config.yaml (else every enabled server is added);
 * - `subscribe` without --secret keeps an existing route's secret, an update keeps `enabled: false`, and
 *   the gateway answers 403 for a disabled route; `webhook remove` refuses while the platform is off;
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

export { hermesHome };
export const subscriptionsPath = () => join(hermesHome(), "webhook_subscriptions.json");

/** The argv for `hermes …`; without `secret`, hermes keeps the route's existing one. */
export function subscribeArgs(profileName: string, flags: HermesFlags, secret?: string): string[] {
  if (!!flags.deliver === !!flags.cronJob) {
    throw new Error(
      "Where should Hermes tell you about important mail? Pass one of:\n" +
        "  --deliver <telegram|discord|slack|…>   a platform connected to your Hermes gateway (--deliver-chat-id <id> for a specific chat; --deliver log keeps it in the gateway log)\n" +
        `  --cron-job <job>                       an existing Hermes cron job (id or name, see \`hermes cron list\`) whose enabled_toolsets is exactly ["${mcpServerName(profileName)}"]; its prompt and delivery apply`,
    );
  }
  if (flags.deliverChatId && !flags.deliver) throw new Error("--deliver-chat-id goes with --deliver.");
  if (flags.deliver && !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(flags.deliver)) throw new Error(`--deliver takes a platform name such as telegram, not "${flags.deliver}".`);
  const args = ["webhook", "subscribe", hermesRoute(profileName), ...(secret ? ["--secret", secret] : []), "--prompt", HERMES_ROUTE_PROMPT, "--description", `agentinbox listener (profile ${profileName})`];
  if (flags.deliver) args.push("--deliver", flags.deliver);
  // = form: chat ids such as Telegram's -100… must not look like an option.
  if (flags.deliverChatId) args.push(`--deliver-chat-id=${flags.deliverChatId}`);
  if (flags.cronJob) args.push(`--cron-job=${flags.cronJob}`);
  if (flags.script) args.push(`--script=${flags.script}`);
  return args;
}

/**
 * `toolsets ["mcp-<server>"]` (and a cron job's `["<server>"]`) only narrow Hermes' MCP servers when that
 * server is an enabled one in Hermes' config.yaml; otherwise Hermes adds every enabled MCP server. So the
 * agentinbox server must be there and on, or nothing is set up.
 */
export function checkMcpServer(profileName: string, home = hermesHome()): void {
  const server = mcpServerName(profileName);
  const file = join(home, "config.yaml");
  const state = existsSync(file) ? yamlMcpServerState(readFileSync(file, "utf8"), server) : "missing";
  if (state === "enabled") return;
  const why =
    state === "missing"
      ? `Hermes has no MCP server "${server}" (in ${file})`
      : state === "disabled"
        ? `the MCP server "${server}" is disabled in ${file}`
        : `${file} lays out mcp_servers in a way agentinbox can't check, so it can't tell whether "${server}" is on`;
  throw new Error(
    `${why}. The route's tools are limited to that server, and Hermes only honours the limit for an enabled server (otherwise it adds every MCP server you have).
` +
      `  Run \`${NPX} setup-mcp --tool hermes${profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`}\` first (check it with \`hermes mcp test ${server}\`), then run this again.`,
  );
}

/**
 * A cron job gets the email with its OWN toolset, which may include a shell. Only a job limited to the
 * agentinbox MCP server (enabled_toolsets naming exactly the bare server name) is accepted.
 */
export function checkCronJob(ref: string, profileName: string, home = hermesHome()): void {
  const file = join(home, "cron", "jobs.json");
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
 * Edits <HERMES_HOME>/webhook_subscriptions.json under Hermes' own lock (.webhook_subscriptions.lock,
 * flock), with an atomic 0600 write, as hermes_cli/webhook.py does. Python because Hermes needs it anyway
 * and Node has no flock. The secret comes in on stdin, never in argv. Modes:
 * - prepare: the route exists, disabled (`enabled: false`), with the listener's secret. `hermes webhook
 *   subscribe` without --secret then keeps both (it reuses an existing secret and never re-enables a route).
 * - confine: only if the route still has that secret and is still disabled, set its toolsets and enable it.
 * - remove: delete the route if it has that secret (cleanup after a failure).
 */
const ROUTES_PY = `
import fcntl, json, os, sys, tempfile
mode, path, lock, name, toolset = sys.argv[1:6]
inp = json.load(sys.stdin)
os.makedirs(os.path.dirname(lock), exist_ok=True)
with open(lock, "a+b") as lf:
    fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            subs = json.load(f)
    except FileNotFoundError:
        subs = {}
    if not isinstance(subs, dict):
        sys.exit("%s is not a JSON object" % path)
    route = subs.get(name)
    if mode == "prepare":
        route = dict(route) if isinstance(route, dict) else {"description": inp["description"]}
        route["secret"] = inp["secret"]
        route["enabled"] = False
        route.pop("toolsets", None)
        subs[name] = route
    elif mode == "confine":
        if not isinstance(route, dict):
            sys.exit("route %s is missing" % name)
        if route.get("secret") != inp["secret"] or route.get("enabled") is not False:
            sys.exit("route %s changed while it was being set up; run this again" % name)
        route["toolsets"] = [toolset]
        route["enabled"] = True
    elif mode == "remove":
        if not isinstance(route, dict) or route.get("secret") != inp["secret"]:
            sys.exit(0)
        del subs[name]
    else:
        sys.exit("bad mode")
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

interface HermesRouteEntry {
  secret?: string;
  toolsets?: unknown;
  enabled?: unknown;
  prompt?: unknown;
  cron_job?: unknown;
  deliver?: unknown;
}

/** One route from the subscriptions file (undefined when it has none by that name); throws when the file can't be read. */
const readRoute = (name: string, file: string): HermesRouteEntry | undefined =>
  (JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, HermesRouteEntry>)[name];

/** Whether a route's toolsets are exactly the confined `["mcp-<server>"]` for this profile. */
const isConfined = (route: HermesRouteEntry, profileName: string) => JSON.stringify(route.toolsets) === JSON.stringify([hermesRouteToolset(profileName)]);

/** Re-reads the subscriptions file: the route must have the real secret, exactly our toolsets, and the file must be 0600. */
export function verifyRoute(profileName: string, secret: string, file = subscriptionsPath(), name = hermesRoute(profileName)): string | null {
  try {
    if ((statSync(file).mode & 0o077) !== 0) return `${file} is readable by other users`;
    const route = readRoute(name, file);
    if (!route) return `route ${name} is missing`;
    if (route.secret !== secret) return "the route's secret isn't the listener's";
    if (route.enabled === false) return "the route is disabled";
    if (!isConfined(route, profileName)) return `the route's toolsets are ${JSON.stringify(route.toolsets ?? null)}`;
    return null;
  } catch (err) {
    return (err as Error).message.split("\n")[0]!;
  }
}

/** The route name in a Hermes forward URL (`/webhooks/<name>`); null for other shapes such as `/p/<profile>/webhooks/<name>`. */
export function hermesRouteName(forwardUrl: string): string | null {
  try {
    const m = /^\/webhooks\/([^/]+)\/?$/.exec(decodeURIComponent(new URL(forwardUrl).pathname));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * The route the listener forwards to, checked in <HERMES_HOME>/webhook_subscriptions.json: a warning when
 * email content may reach its agent's prompt (no cron_job, and a prompt with a `{…}` placeholder, or no
 * prompt at all, treated the same) while its toolsets aren't the confined `["mcp-<server>"]`.
 * Anything else, including a missing route or an unreadable file, is a debug line at most.
 */
export function routeWarning(profileName: string, forwardUrl: string, file = subscriptionsPath()): { level: "warn" | "debug"; message: string } | null {
  const name = hermesRouteName(forwardUrl);
  if (!name) return { level: "debug", message: `Hermes route in ${forwardUrl} not checked (not a /webhooks/<name> URL)` };
  let route: HermesRouteEntry | undefined;
  try {
    route = readRoute(name, file);
  } catch (err) {
    return { level: "debug", message: `Hermes route ${name} not checked: ${(err as Error).message.split("\n")[0]}` };
  }
  if (!route) return { level: "debug", message: `Hermes route ${name} isn't in ${file}` };
  if (isConfined(route, profileName)) return null;
  const prompt = typeof route.prompt === "string" ? route.prompt : "";
  if (route.cron_job || (prompt && !/\{[^{}\s]+\}/.test(prompt))) {
    return { level: "debug", message: `Hermes route ${name} isn't limited to the agentinbox tools, but the event doesn't reach its prompt (${route.cron_job ? "it fires a cron job" : "no placeholders"})` };
  }
  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  const deliver = typeof route.deliver === "string" && /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(route.deliver) ? route.deliver : "<platform>";
  const own = hermesRoute(profileName);
  const fix =
    name === own
      ? `Fix: \`${NPX} listen hermes${p} --deliver ${deliver} --run\` limits it to ${hermesRouteToolset(profileName)}.`
      : `Fix: \`${NPX} listen hermes${p} --deliver ${deliver} --run\` creates the confined route ${own}; ` +
        `\`${NPX} listen${p} --save --recipe hermes\` points this listener at it (or --forward <its URL> --save; as a service: \`${NPX} listen service install${p} --recipe hermes\`); ` +
        `then \`hermes webhook remove ${name}\`.`;
  return {
    level: "warn",
    message:
      `The Hermes route ${name} this listener forwards to puts the email into its prompt but isn't limited to the agentinbox tools (toolsets: ${JSON.stringify(route.toolsets ?? null)}): ` +
      `email-triggered runs there get Hermes' web tools and every MCP server, including any calendar access granted. ${fix}`,
  };
}

export interface HermesDeps {
  /** Runs hermes and python3 (tests). */
  spawn?: typeof spawnSync;
}

export async function hermesSubscribe(profileArg: string, flags: HermesFlags, deps: HermesDeps = {}): Promise<number> {
  const profileName = validProfileName(profileArg);
  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  const profile = loadProfile(profileName);
  // Validates the flags, the agentinbox MCP server in Hermes and a cron job's tools before a secret is
  // generated or anything runs.
  subscribeArgs(profileName, flags);
  const home = hermesHome();
  checkMcpServer(profileName, home);
  if (flags.cronJob) checkCronJob(flags.cronJob, profileName, home);
  const { secret, created } = forwardSecret(profile);
  if (created) {
    // Same as `listen secret`: generated once and kept, so the listener and Hermes agree from now on.
    profile.forwardSecret = secret;
    saveProfile(profileName, profile);
  }
  const base = hermesGatewayBase(profile.forward?.url);
  const route = `${base}/webhooks/${hermesRoute(profileName)}`;
  const forwardsThere = profile.forward?.url === route;
  const toolset = hermesRouteToolset(profileName);
  const name = hermesRoute(profileName);
  const file = join(home, "webhook_subscriptions.json");

  if (!flags.run) {
    const npx = `npx -y agentinbox-cli@${version}`;
    const shown = subscribeArgs(profileName, flags, "SECRET").map((a) => (a === "SECRET" ? `"$S"` : shellQuote(a)));
    out(`Hermes route for profile "${profileName}": ${route}`);
    out();
    out(`Set it up with (recommended; it also limits the route to the agentinbox tools, see step 2):`);
    out(`  ${pc.cyan(`${NPX} listen hermes${p} ${flagsText(flags)} --run`)}`);
    out();
    out(pc.gray("Or by hand, in two steps. 1. Create the route; the secret is read from the profile in a subshell as it runs (stops"));
    out(pc.gray("if that fails), so it isn't typed, kept in your shell history or left in a variable. hermes prints it back once."));
    out(`  ( S=$(${npx} listen secret${p}) && HERMES_HOME=${shellQuote(home)} hermes ${shown.join(" ")} )`);
    out();
    out(`2. ${pc.bold("REQUIRED:")} in ${file}, add this to the "${name}" entry (the gateway reloads the file by itself):`);
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
  // Every hermes we run uses the home whose files we edit.
  const env = { ...process.env, HERMES_HOME: home };
  const lock = join(dirname(file), ".webhook_subscriptions.lock");
  const redact = (t: string | null | undefined) => (t ?? "").split(secret).join("whsec_…(hidden)");
  const routes = (mode: "prepare" | "confine" | "remove"): string | null => {
    const r = spawn("python3", ["-I", "-c", ROUTES_PY, mode, file, lock, name, toolset], {
      encoding: "utf8",
      input: JSON.stringify({ secret, description: `agentinbox listener (profile ${profileName})` }),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (r.error) return `python3: ${(r.error as NodeJS.ErrnoException).code === "ENOENT" ? "not found (Hermes needs it; install python3)" : r.error.message}`;
    return r.status === 0 ? null : redact(`${r.stderr ?? ""}`.trim().split("\n").at(-1)) || `python3 exited ${r.status}`;
  };

  // 1. The route exists, disabled, with the listener's secret: hermes then never needs the secret in its argv
  //    (`ps`), and the route can't run anything before step 3 (Hermes answers 403 for a disabled route).
  const prepared = routes("prepare");
  if (prepared) {
    out(pc.red(`✖ Couldn't prepare the Hermes route in ${file}: ${prepared}. Nothing was changed.`));
    return 1;
  }
  const fail = (why: string): number => {
    out();
    out(pc.red(`✖ ${why}`));
    // Never leave the route behind half set up.
    const rm = spawn("hermes", ["webhook", "remove", name], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    const removedByHermes = !rm.error && rm.status === 0 && /Removed webhook subscription/.test(rm.stdout ?? "");
    const ours = removedByHermes ? null : routes("remove");
    if (removedByHermes || ours === null) out(`  Removed the route ${name} again${removedByHermes ? "" : " (hermes couldn't, so agentinbox did, under Hermes' lock)"}; nothing receives the listener's events. Fix the cause and run this again.`);
    else out(pc.red(`  Removing the route failed too (${ours}). It is disabled, so it runs nothing; remove it with \`hermes webhook remove ${name}\`.`));
    return 1;
  };

  // 2. Without --secret, hermes keeps the route's secret, and it never re-enables a disabled route.
  const run = spawn("hermes", subscribeArgs(profileName, flags), { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  if (run.error) {
    const missing = (run.error as NodeJS.ErrnoException).code === "ENOENT";
    return fail(missing ? "hermes isn't on your PATH. Install Hermes Agent (https://hermes-agent.nousresearch.com), or run this where `hermes` works." : `Couldn't run hermes: ${redact(run.error.message)}`);
  }
  const text = `${redact(run.stdout)}${redact(run.stderr)}`.trim();
  if (text) out(text.split("\n").map((l) => `  ${pc.gray("hermes │")} ${l}`).join("\n"));
  // hermes prints "Error: …" (or its setup hint) and still exits 0, so success is the line it prints on success.
  if (run.status !== 0 || !/(Created|Updated) webhook subscription/.test(run.stdout ?? "")) {
    const hint = /not enabled/i.test(text) ? " Turn on the gateway's webhook platform first: hermes gateway setup (or WEBHOOK_ENABLED=true in ~/.hermes/.env)." : "";
    return fail(`hermes didn't create the route${run.status ? ` (exit ${run.status})` : ""}.${hint}`);
  }

  // 3. Limit its tools and only then enable it, under the lock; 4. read it back.
  const problem = routes("confine") ?? verifyRoute(profileName, secret, file);
  if (problem) return fail(`Couldn't limit the Hermes route to the agentinbox tools: ${problem}.`);
  out();
  out(`${pc.green("✔")} Hermes route ${name} is set up with this listener's secret, limited to the toolset ${toolset} (the agentinbox MCP server; no other MCP servers or web tools).`);
  out(pc.gray(`  Hermes may still add plugin toolsets you never configured for its webhook platform (see \`hermes tools\`).`));
  out(pc.gray(`  Running \`hermes webhook subscribe ${name}\` yourself later resets the limit; run this command again afterwards.`));
  if (await gatewayHealthy(base)) out(`  The Hermes gateway answers at ${base}.`);
  else out(pc.yellow(`  The Hermes gateway isn't answering at ${base}/health: start it (hermes gateway), or if it uses another port, forward there with --forward <its URL>/webhooks/${name}.`));
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
