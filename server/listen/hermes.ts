import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { isLoopbackHost } from "./transport.ts";
import { forwardSecret } from "./options.ts";
import { DEFAULT_PROFILE, validProfileName } from "./paths.ts";
import { loadProfile, saveProfile } from "./profile.ts";
import { HERMES_GATEWAY, HERMES_ROUTE_PROMPT, hermesRoute, shellQuote } from "./recipes.ts";
import { NPX } from "./version.ts";

/**
 * `agentinbox listen hermes`: the Hermes gateway webhook route `--recipe hermes` forwards to, created with
 * `hermes webhook subscribe` (Hermes Agent, NousResearch/hermes-agent). Facts this relies on, from Hermes'
 * docs (user-guide/messaging/webhooks) and source (hermes_cli/webhook.py, gateway/platforms/webhook.py):
 * routes live at /webhooks/<name> on port 8644; Standard Webhooks signatures are verified, with a whsec_
 * secret base64-decoded like ours; `--secret` is only accepted as an argument (no env var, file or stdin);
 * `subscribe` prints the secret back; `--prompt` takes {dot.path}, {event_type} and {__raw__} placeholders;
 * a reply that is just [SILENT] isn't delivered.
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
const REDACTED = "whsec_…(hidden)";

/** The argv for `hermes …` (the secret is a placeholder when printing). */
export function subscribeArgs(profileName: string, flags: HermesFlags, secret: string): string[] {
  if (!!flags.deliver === !!flags.cronJob) {
    throw new Error(
      "Where should Hermes tell you about important mail? Pass one of:\n" +
        "  --deliver <telegram|discord|slack|…>   a platform connected to your Hermes gateway (--deliver-chat-id <id> for a specific chat; --deliver log keeps it in the gateway log)\n" +
        "  --cron-job <job>                       an existing Hermes cron job (id or name, see `hermes cron list`); its prompt and delivery apply",
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

/** The gateway the listener actually forwards to: the saved Hermes-shaped forward URL, else the default. */
function gatewayBase(profileName: string, forwardUrl: string | undefined): string {
  if (forwardUrl) {
    const u = new URL(forwardUrl);
    if (isLoopbackHost(u.hostname) && u.pathname === `/webhooks/${hermesRoute(profileName)}`) return u.origin;
  }
  return HERMES_GATEWAY;
}

async function gatewayHealthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return res.ok;
  } catch {
    return false;
  }
}

export interface HermesDeps {
  /** Runs hermes (tests). */
  spawn?: typeof spawnSync;
}

export async function hermesSubscribe(profileArg: string, flags: HermesFlags, deps: HermesDeps = {}): Promise<number> {
  const profileName = validProfileName(profileArg);
  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  const profile = loadProfile(profileName);
  // Validates the flags before a secret is generated or anything runs.
  subscribeArgs(profileName, flags, "");
  const { secret, created } = forwardSecret(profile);
  if (created) {
    // Same as `listen secret`: generated once and kept, so the listener and Hermes agree from now on.
    profile.forwardSecret = secret;
    saveProfile(profileName, profile);
  }
  const base = gatewayBase(profileName, profile.forward?.url);
  const forwardsThere = profile.forward?.url === `${base}/webhooks/${hermesRoute(profileName)}`;
  const route = `${base}/webhooks/${hermesRoute(profileName)}`;

  if (!flags.run) {
    const shown = subscribeArgs(profileName, flags, "SECRET").map((a) => (a === "SECRET" ? `"$(${NPX.replace(/^npx /, "npx -y ")} listen secret${p})"` : shellQuote(a)));
    out(`Hermes route for profile "${profileName}": ${route}`);
    out();
    out(`Create it (agentinbox runs hermes and passes the listener's secret without showing it):`);
    out(`  ${pc.cyan(`${NPX} listen hermes${p} ${flagsText(flags)} --run`)}`);
    out();
    out(pc.gray("Or run hermes yourself; the secret is read from the profile as it runs, so it isn't typed or kept in your"));
    out(pc.gray("shell history (hermes prints it back once as Secret: …):"));
    out(`  hermes ${shown.join(" ")}`);
    printNext(forwardsThere, p);
    return 0;
  }

  const run = (deps.spawn ?? spawnSync)("hermes", subscribeArgs(profileName, flags, secret), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const redact = (t: string | null | undefined) => (t ?? "").split(secret).join(REDACTED);
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
  out();
  out(`${pc.green("✔")} Hermes route ${hermesRoute(profileName)} is set up with this listener's secret.`);
  if (await gatewayHealthy(base)) out(`  The Hermes gateway answers at ${base}.`);
  else out(pc.yellow(`  The Hermes gateway isn't answering at ${base}/health: start it (hermes gateway), or if it uses another port, forward there with --forward <its URL>/webhooks/${hermesRoute(profileName)}.`));
  printNext(forwardsThere, p);
  return 0;
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
