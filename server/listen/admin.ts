import pc from "picocolors";
import { ApiError, getSelf } from "./api.ts";
import { Dispatcher, type Job, type Target } from "./dispatcher.ts";
import { runCommand } from "./exec.ts";
import { forwardEvent } from "./forward.ts";
import { type ListenFlags, resolveListen } from "./options.ts";
import { DEFAULT_PROFILE, deadPath, logPath, profilePath, validProfileName } from "./paths.ts";
import { loadProfile, saveProfile } from "./profile.ts";
import { forwardSecret } from "./options.ts";
import { isServiceInstalled, launchdLabel, unitName } from "./service.ts";
import { type DeadEntry, pidAlive, readDead, readStatus, writeDead } from "./state.ts";
import { formatDuration, safeText } from "./ui.ts";
import { NPX } from "./version.ts";

const out = (s = "") => process.stdout.write(`${s}\n`);
const flagFor = (profile: string) => (profile === DEFAULT_PROFILE ? "" : ` --profile ${profile}`);
const ago = (iso: string | null | undefined) => (iso ? `${formatDuration(Date.now() - Date.parse(iso))} ago` : "never");

// ───────────── listen secret ─────────────

/** Prints the forward-mode signing secret (generating and saving it on first use). */
export function printSecret(profileName: string, opts: { rotate?: boolean }): void {
  const name = validProfileName(profileName);
  const profile = loadProfile(name);
  let { secret, created } = forwardSecret(profile);
  if (opts.rotate) {
    secret = forwardSecret({ ...profile, forward: undefined, forwardSecret: undefined }).secret;
    created = true;
  }
  if (created) {
    if (profile.forward) profile.forward = { ...profile.forward, secret };
    else profile.forwardSecret = secret;
    saveProfile(name, profile);
    process.stderr.write(pc.gray(`${opts.rotate ? "Rotated" : "Generated"} the forward signing secret for profile "${name}"${opts.rotate ? "; restart the listener" : ""}.\n`));
  }
  // The secret alone on stdout, so `export AGENTINBOX_WEBHOOK_SECRET=$(agentinbox listen secret)` works.
  out(secret);
}

// ───────────── listen status ─────────────

export async function printStatus(profileName: string): Promise<void> {
  const name = validProfileName(profileName);
  const profile = loadProfile(name);
  const st = readStatus(name);
  const alive = st ? pidAlive(st.pid) && !st.stoppedAt : false;
  const dead = readDead(name);

  out(`${pc.bold("Profile")}   ${name}  ${pc.gray(profilePath(name))}`);
  out(`${pc.bold("Agent")}     ${safeText(profile.agentName)} ${pc.gray(`(${profile.agentId})`)}`);
  out(`${pc.bold("Daemon")}    ${profile.url}`);
  out(`${pc.bold("Consumer")}  ${st?.consumer ?? profile.consumer}`);
  const targets = [profile.exec ? `exec ${safeText(profile.exec, 120)}` : null, profile.forward ? `forward ${profile.forward.url}` : null].filter(Boolean);
  out(`${pc.bold("Runs")}      ${targets.length ? targets.join(" · ") : pc.gray("nothing saved (pass --exec/--forward with --save)")}`);

  let svc = "not installed";
  if (process.platform === "linux" || process.platform === "darwin") {
    if (isServiceInstalled(name)) svc = `installed (${process.platform === "linux" ? unitName(name) : launchdLabel(name)}; details: ${NPX} listen service status${flagFor(name)})`;
  }
  out(`${pc.bold("Service")}   ${svc}`);

  try {
    const self = await getSelf(profile.url, profile.apiKey, 5000);
    out(`${pc.bold("Key")}       ${pc.green("valid")} · ${self.grants.length ? self.grants.map((g) => `${g.accountEmail} (${g.capabilities.join(", ")}; ${g.sendMode})`).join(", ") : pc.yellow("no mailbox grants")}`);
  } catch (err) {
    const revoked = err instanceof ApiError && (err.status === 401 || err.status === 403);
    out(`${pc.bold("Key")}       ${revoked ? pc.red(`rejected: ${err.message}`) : pc.yellow(`unchecked: ${err instanceof Error ? err.message : String(err)}`)}`);
  }

  if (!st) {
    out(`${pc.bold("Listener")}  ${pc.gray("has not run yet")}`);
  } else {
    const state = !alive
      ? pc.gray(`not running${st.stoppedAt ? ` (stopped ${ago(st.stoppedAt)}${st.exitReason ? `: ${safeText(st.exitReason, 160)}` : ""})` : " (exited unexpectedly)"}`)
      : st.connected
        ? pc.green(`running (pid ${st.pid}), connected ${ago(st.connectedSince)}`)
        : pc.yellow(`running (pid ${st.pid}), disconnected${st.lastDisconnect ? ` ${ago(st.lastDisconnect.at)}: ${safeText(st.lastDisconnect.reason, 160)}` : ""}`);
    out(`${pc.bold("Listener")}  ${state}`);
    out(`${pc.bold("Cursor")}    acked #${st.ackedSeq} · received #${st.receivedSeq}${alive && st.running ? ` · ${st.running} in progress` : ""} · last event ${ago(st.lastEventAt)}`);
    if (st.recent.length) {
      out(pc.bold("Recent"));
      for (const r of st.recent.slice(0, 8)) {
        const icon = r.outcome === "succeeded" ? pc.green("✓") : r.outcome === "dead" ? pc.red("✖") : r.outcome === "retrying" ? pc.yellow("↻") : pc.gray("·");
        out(`  ${icon} #${r.seq} ${r.type} ${pc.gray(`${ago(r.at)}${r.attempts > 1 ? `, ${r.attempts} attempts` : ""}${r.error && r.outcome !== "succeeded" ? `, ${safeText(r.error, 100)}` : ""}`)}`);
      }
    }
  }
  out(`${pc.bold("Dead")}      ${dead.length ? pc.red(`${dead.length} event${dead.length > 1 ? "s" : ""}`) + pc.gray(` (inspect: ${NPX} listen dead${flagFor(name)})`) : "0"}`);
  out(`${pc.bold("Log")}       ${logPath(name)}`);
}

// ───────────── listen dead ─────────────

export function printDead(profileName: string, opts: { json?: boolean }): void {
  const name = validProfileName(profileName);
  const entries = readDead(name);
  if (opts.json) {
    for (const e of entries) out(JSON.stringify(e));
    return;
  }
  if (!entries.length) {
    out(`No dead events for profile "${name}".`);
    return;
  }
  for (const e of entries) {
    const m = e.payload.data.message;
    out(`${pc.red("✖")} #${e.seq} ${e.type} ${pc.gray(e.id)}  ${pc.gray(`died ${ago(e.deadAt)} after ${e.attempts} attempts`)}`);
    if (m) out(`    from ${safeText(m.from?.email ?? "?", 80)}  "${safeText(m.subject, 80)}"`);
    out(pc.gray(`    ${safeText(e.error, 300)}`));
  }
  out();
  out(pc.gray(`${entries.length} dead event${entries.length > 1 ? "s" : ""} in ${deadPath(name)}.`));
  out(pc.gray(`Replay with: ${NPX} listen dead --replay${flagFor(name)}   (one: --id <evt_…>; drop all: --clear)`));
}

export function clearDead(profileName: string, id?: string): void {
  const name = validProfileName(profileName);
  const entries = readDead(name);
  const keep = id ? entries.filter((e) => e.id !== id) : [];
  writeDead(name, keep);
  out(`Removed ${entries.length - keep.length} dead event${entries.length - keep.length === 1 ? "" : "s"}.`);
}

/**
 * Runs dead events again through the profile's targets (or the ones passed as flags). Successes are
 * removed from dead.jsonl; failures stay. Returns how many still failed.
 */
export async function replayDead(flags: ListenFlags & { id?: string }, opts: { retryDelayMs?: (n: number) => number } = {}): Promise<number> {
  const name = validProfileName(flags.profile ?? DEFAULT_PROFILE);
  const profile = loadProfile(name);
  const { config } = resolveListen(name, profile, { ...flags, save: false });
  const all = readDead(name);
  const chosen = all.filter((e) => !flags.id || e.id === flags.id);
  if (!chosen.length) {
    out(flags.id ? `No dead event with id ${flags.id}.` : `No dead events for profile "${name}".`);
    return 0;
  }
  const available: Target[] = [];
  if (config.exec) available.push("exec");
  if (config.forward) available.push("forward");
  if (!available.length) throw new Error("Nothing to replay to: pass --exec or --forward, or save one in the profile.");

  const timeoutMs = config.timeoutSeconds * 1000;
  const failed = new Map<string, DeadEntry>();
  const bySeq = new Map(chosen.map((e) => [e.seq, e]));
  const dispatcher = new Dispatcher({
    targets: available,
    concurrency: config.concurrency,
    maxAttempts: config.maxAttempts,
    retryDelayMs: opts.retryDelayMs,
    run: async (job: Job, signal) => {
      const errors: string[] = [];
      if (job.remaining.has("exec") && config.exec) {
        const r = await runCommand(config.exec, job.payload, { timeoutMs, signal });
        if (r.ok) job.remaining.delete("exec");
        else errors.push(`command: ${r.error}`);
      }
      if (job.remaining.has("forward") && config.forward) {
        const r = await forwardEvent(config.forward.url, config.forward.secret, job.payload, { timeoutMs: Math.min(timeoutMs, 30_000), signal });
        if (r.ok) job.remaining.delete("forward");
        else errors.push(`forward: ${r.error}`);
      }
      return errors;
    },
    onAdvance: () => {},
    onDead: (job) => {
      const e = bySeq.get(job.seq)!;
      failed.set(e.id, { ...e, deadAt: new Date().toISOString(), attempts: e.attempts + job.attempts, error: job.lastError ?? "failed" });
      out(`${pc.red("✖")} #${job.seq} still failing: ${safeText(job.lastError ?? "failed", 200)}`);
    },
    onFinished: (job) => {
      if (job.outcome === "succeeded") out(`${pc.green("✓")} #${job.seq} ${job.payload.type} replayed`);
    },
  });
  out(`Replaying ${chosen.length} dead event${chosen.length > 1 ? "s" : ""} (up to ${config.maxAttempts} attempts each)…`);
  for (const e of [...chosen].sort((a, b) => a.seq - b.seq)) dispatcher.push(e.payload);
  await dispatcher.idle();

  const replayed = new Set(chosen.map((e) => e.id));
  // Re-read so entries added by a running listener meanwhile are kept.
  const current = readDead(name);
  writeDead(name, [...current.filter((e) => !replayed.has(e.id)), ...failed.values()]);
  out(`${chosen.length - failed.size} replayed, ${failed.size} still dead.`);
  return failed.size;
}
