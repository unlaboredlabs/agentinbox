import { hostname } from "node:os";
import pc from "picocolors";
import type { WebhookPayload } from "../../shared/types.ts";
import { ackEvents, ApiError, getSelf } from "./api.ts";
import { Dispatcher, type Job, type Target } from "./dispatcher.ts";
import { matchesLocal, parsePayload } from "./event.ts";
import { killAllRuns, runCommand } from "./exec.ts";
import { existsSync } from "node:fs";
import { ensurePrivateDir } from "./fsutil.ts";
import { claudeMcpConfigPath, writeClaudeMcpConfig } from "./mcpheader.ts";
import { forwardEvent } from "./forward.ts";
import { createListenLogger, type ListenLogger } from "./logfile.ts";
import { describeFilter, type EffectiveConfig, type ListenFlags, resolveListen } from "./options.ts";
import { DEFAULT_PROFILE, logPath, validProfileName } from "./paths.ts";
import { loadProfile, type Profile, saveProfile } from "./profile.ts";
import { acquireProfileLock } from "./lock.ts";
import { appendDead, readStatus, StatusWriter } from "./state.ts";
import { EventStream } from "./stream.ts";
import { checkTransport, insecureBanner } from "./transport.ts";
import { formatDuration, safeText } from "./ui.ts";
import { NPX, version } from "./version.ts";

/** Exit codes. 78 (EX_CONFIG) means "don't restart me": the service units are told not to. */
export const EXIT = { ok: 0, error: 1, revoked: 78 } as const;

export interface RunListenerOptions {
  flags: ListenFlags;
  /** Stops the listener (tests); the CLI uses SIGINT/SIGTERM. */
  signal?: AbortSignal;
  handleSignals?: boolean;
  log?: ListenLogger;
  /** Test knobs. */
  retryDelayMs?: (attempt: number) => number;
  stallMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  blockedRetryMs?: number;
  /** Time a service waits before exiting after revocation where the supervisor can't be told not to restart (launchd). */
  revokedExitDelayMs?: number;
}

/** Acknowledges the finished prefix, coalescing and retrying in the background. */
class Acker {
  private wanted = 0;
  acked = 0;
  private busy: Promise<void> | null = null;
  private retry: NodeJS.Timeout | null = null;
  constructor(
    private readonly post: (seq: number) => Promise<number>,
    private readonly log: ListenLogger,
  ) {}

  request(seq: number): void {
    this.wanted = Math.max(this.wanted, seq);
    this.kick();
  }

  private kick(): void {
    if (this.busy || this.retry || this.wanted <= this.acked) return;
    const seq = this.wanted;
    this.busy = this.post(seq)
      .then((acked) => {
        this.acked = Math.max(this.acked, acked, seq);
      })
      .catch((err: unknown) => {
        this.log.debug(`ack failed, retrying: ${err instanceof Error ? err.message : String(err)}`, { seq });
        this.retry = setTimeout(() => {
          this.retry = null;
          this.kick();
        }, 5000);
        this.retry.unref();
      })
      .finally(() => {
        this.busy = null;
        this.kick();
      });
  }

  /** Best-effort final ack on shutdown. */
  async flush(timeoutMs = 3000): Promise<void> {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.busy) await Promise.race([this.busy, new Promise((r) => setTimeout(r, 100))]);
      else if (this.wanted > this.acked) {
        this.kick();
        if (this.retry) break;
      } else return;
    }
  }
}

const describeEvent = (p: WebhookPayload) => {
  const m = p.data.message;
  const who = m?.from?.email ? ` from ${safeText(m.from.email, 80)}` : "";
  const subject = m?.subject ? ` "${safeText(m.subject, 70)}"` : "";
  return `#${p.data.seq} ${p.type}${who}${subject}`;
};

export async function runListener(opts: RunListenerOptions): Promise<number> {
  const profileName = validProfileName(opts.flags.profile ?? DEFAULT_PROFILE);
  let profile: Profile = loadProfile(profileName);
  const { config, next, changed } = resolveListen(profileName, profile, opts.flags);
  if (changed) {
    saveProfile(profileName, next);
    profile = next;
  }
  // Under launchd, stdout goes to a file nobody rotates; the rotated listen.log already has everything.
  const quietConsole = process.env.AGENTINBOX_SERVICE === "1" && process.platform === "darwin";
  const log = opts.log ?? createListenLogger({ path: logPath(profileName), debug: !!process.env.AGENTINBOX_DEBUG, console: !quietConsole });
  if (opts.flags.save) log.info(`Saved these settings to profile "${profileName}".`);

  const verdict = await checkTransport(profile.url, { insecure: config.insecure });
  if (verdict.warning) {
    process.stderr.write(`${insecureBanner(verdict.warning)}\n`);
    log.warn(verdict.warning);
  }

  const targets: Target[] = [];
  if (config.exec) targets.push("exec");
  if (config.forward) targets.push("forward");
  const dryRun = !!opts.flags.dryRun;
  if (!targets.length && !dryRun) {
    throw new Error(
      `Nothing to run for events. Pass --exec "<command>" and/or --forward http://localhost:<port>/<path> (add --save to keep it in profile "${profileName}"),\n` +
        `  or --dry-run to just print matching events. Recipes: ${NPX} listen --help`,
    );
  }

  if (config.exec && process.platform === "win32" && !dryRun) {
    throw new Error("--exec needs a POSIX shell (/bin/sh) and isn't supported on Windows. Use --forward to a local HTTP handler instead.");
  }

  // One listener per profile (they would share the cursor and run every event twice).
  const releaseLock = acquireProfileLock(profileName);
  try {
    const firstRun = readStatus(profileName)?.consumer !== config.consumer;

    if (config.cwdIsDefault) ensurePrivateDir(config.cwd);
    // The Claude Code recipe loads this (keyless) MCP config; recreate it if it's missing.
    if (!existsSync(claudeMcpConfigPath(profileName))) writeClaudeMcpConfig(profileName, `${profile.url}/mcp`);
    if (!quietConsole) printBanner(log, profileName, profile, config, dryRun);
    if (opts.flags.fromStart) log.info("Processing every stored event this agent can see, from the oldest (--from-start; only applies to a new consumer).");
    else if (firstRun) log.info(`Listening for new events from now on (use --from-start to process existing ones).`);

    const status = new StatusWriter(profileName, {
      pid: process.pid,
      profile: profileName,
      url: profile.url,
      consumer: config.consumer,
      version,
      startedAt: new Date().toISOString(),
      connected: false,
      connectedSince: null,
      lastDisconnect: null,
      lastEventAt: null,
      receivedSeq: 0,
      ackedSeq: 0,
      running: 0,
      recent: [],
      stoppedAt: null,
      exitReason: null,
      exec: config.exec,
      forward: config.forward?.url ?? null,
    });
    status.flush();

    // Who am I? Informational and not awaited: the stream itself decides whether the key is valid.
    void getSelf(profile.url, profile.apiKey, 8000).then(
      (self) => {
        const scopes = self.grants.map((g) => `${g.accountEmail} (${g.capabilities.join(", ")}; ${g.sendMode})`);
        log.info(`Signed in as agent "${safeText(self.name)}"${scopes.length ? `: ${scopes.join(", ")}` : pc.yellow(": no mailbox grants yet, ask the operator to add one")}`);
      },
      (err: unknown) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return; // The stream reports it.
        log.debug(`identity check failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    );

    // Re-checked before every reconnect and ack: a *.ts.net / *.localhost name could start resolving elsewhere.
    const transportOk = () =>
      checkTransport(profile.url, { insecure: config.insecure }).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message.split("\n")[0]! : String(err)),
      );
    const acker = new Acker(async (seq) => {
      const refused = await transportOk();
      if (refused) throw new Error(refused);
      const acked = (await ackEvents(profile.url, profile.apiKey, config.consumer, seq)).ackedSeq;
      // Shown by `listen status` only once the server has confirmed it.
      status.update({ ackedSeq: acked });
      return acked;
    }, log);
    const timeoutMs = config.timeoutSeconds * 1000;

    const runTargets = async (job: Job, signal: AbortSignal): Promise<string[]> => {
      const errors: string[] = [];
      const tag = `#${job.seq}`;
      if (job.remaining.has("exec") && config.exec) {
        const r = await runCommand(config.exec, job.payload, { timeoutMs, signal, cwd: config.cwd });
        const meta = { seq: job.seq, id: job.payload.data.id, attempt: job.attempts, exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs, stdoutTail: r.stdoutTail, stderrTail: r.stderrTail };
        if (signal.aborted) {
          errors.push("stopped");
          log.debug(`${tag} command stopped by shutdown`, meta);
        } else if (r.ok) {
          job.remaining.delete("exec");
          log.debug(`${tag} command finished in ${formatDuration(r.durationMs)}`, meta);
        } else {
          errors.push(`command: ${r.error}`);
          const lastLines = (t: string) =>
            t
              .trim()
              .split("\n")
              .filter((l) => l.trim())
              .slice(-3)
              .map((l) => `  │ ${safeText(l, 300)}`)
              .join("\n");
          const tail = lastLines(r.stderrTail) || lastLines(r.stdoutTail);
          log.warn(`${tag} command failed (attempt ${job.attempts}/${config.maxAttempts}): ${r.error}${tail ? `\n${tail}` : ""}`, meta);
        }
      }
      if (job.remaining.has("forward") && config.forward) {
        const r = await forwardEvent(config.forward.url, config.forward.secret, job.payload, { timeoutMs: Math.min(timeoutMs, 30_000), signal });
        const meta = { seq: job.seq, id: job.payload.data.id, attempt: job.attempts, statusCode: r.statusCode, durationMs: r.durationMs, response: r.response };
        if (signal.aborted) {
          errors.push("stopped");
        } else if (r.ok) {
          job.remaining.delete("forward");
          log.debug(`${tag} forwarded (${r.statusCode}) in ${formatDuration(r.durationMs)}`, meta);
        } else {
          errors.push(`forward: ${r.error}`);
          log.warn(`${tag} forward failed (attempt ${job.attempts}/${config.maxAttempts}): ${r.error}`, meta);
        }
      }
      return errors;
    };

    const dispatcher = new Dispatcher({
      targets: dryRun ? [] : targets,
      concurrency: config.concurrency,
      maxAttempts: config.maxAttempts,
      retryDelayMs: opts.retryDelayMs,
      run: runTargets,
      onAdvance: (seq) => {
        if (dryRun) return;
        acker.request(seq);
      },
      onRetry: (job, delay) => {
        log.info(`${describeEvent(job.payload)}: retrying in ${formatDuration(delay)}`);
        status.addRecent({ seq: job.seq, id: job.payload.data.id, type: job.payload.type, outcome: "retrying", attempts: job.attempts, at: new Date().toISOString(), error: job.lastError });
      },
      onDead: (job) => {
        appendDead(profileName, {
          deadAt: new Date().toISOString(),
          seq: job.seq,
          id: job.payload.data.id,
          type: job.payload.type,
          attempts: job.attempts,
          error: job.lastError ?? "failed",
          targets: [...job.remaining],
          payload: job.payload,
        });
        log.error(`${describeEvent(job.payload)}: gave up after ${job.attempts} attempts (${job.lastError}). Saved to dead letters: ${NPX} listen dead${profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`}`, {
          seq: job.seq,
          id: job.payload.data.id,
        });
      },
      onFinished: (job) => {
        if (job.outcome === "succeeded") log.info(`${pc.green("✓")} ${describeEvent(job.payload)} ${pc.gray(`(${formatDuration(Date.now() - job.firstSeenAt)})`)}`, { seq: job.seq, id: job.payload.data.id, attempts: job.attempts });
        status.addRecent({ seq: job.seq, id: job.payload.data.id, type: job.payload.type, outcome: job.outcome === "dead" ? "dead" : "succeeded", attempts: job.attempts, at: new Date().toISOString(), error: job.lastError });
        status.update({ running: dispatcher.inFlight });
      },
    });

    let downSince: number | null = null;
    /** Reversible refusal currently in effect (logged once per change). */
    let blocked: string | null = null;
    const stream = new EventStream({
      url: profile.url,
      apiKey: profile.apiKey,
      consumer: config.consumer,
      types: config.types,
      includeBody: config.includeBody,
      lastEventId: () => dispatcher.lastSeq,
      stallMs: opts.stallMs,
      beforeConnect: transportOk,
      fromStart: !!opts.flags.fromStart,
      blockedRetryMs: opts.blockedRetryMs,
      onBlocked: (code, text) => {
        downSince ??= Date.now();
        if (blocked !== code) log.warn(`${pc.yellow("⏸")} ${text}`, { code });
        blocked = code;
        status.update({ connected: false, lastDisconnect: { at: new Date().toISOString(), reason: text } });
      },
      minBackoffMs: opts.minBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
      shouldPause: () => dispatcher.backlog >= 200,
      onOpen: () => {
        const after = downSince ? ` after ${formatDuration(Date.now() - downSince)}` : "";
        if (blocked) log.info("Access restored.");
        blocked = null;
        log.info(`${pc.green("●")} Connected${after}. Waiting for events…`);
        downSince = null;
        status.update({ connected: true, connectedSince: new Date().toISOString() });
      },
      onDisconnect: (reason, retryInMs, { serious }) => {
        downSince ??= Date.now();
        const msg = `${pc.yellow("○")} Disconnected: ${reason}. Reconnecting${retryInMs ? ` in ${formatDuration(retryInMs)}` : ""}…`;
        if (serious) log.warn(msg);
        else log.info(msg);
        status.update({ connected: false, lastDisconnect: { at: new Date().toISOString(), reason } });
      },
      onMessage: (m) => {
        if (m.event !== "mail") {
          log.debug(`ignoring unknown stream event "${m.event}"`);
          return;
        }
        let payload: WebhookPayload;
        try {
          payload = parsePayload(m.data);
        } catch (err) {
          log.warn(`Ignoring a malformed event from the stream: ${(err as Error).message}`, { id: m.id });
          return;
        }
        const match = matchesLocal(payload, config);
        if (dryRun && match) {
          log.info(`${pc.cyan("→")} ${describeEvent(payload)} ${pc.gray("(dry run: nothing executed, cursor not advanced)")}`);
        } else if (match) {
          log.info(`${pc.cyan("→")} ${describeEvent(payload)}`, { seq: payload.data.seq, id: payload.data.id, type: payload.type });
        } else {
          log.debug(`skip ${describeEvent(payload)} (filter)`);
        }
        const accepted = dispatcher.push(payload, { skip: !match });
        if (!accepted) log.debug(`duplicate #${payload.data.seq} ignored`);
        status.update({ receivedSeq: dispatcher.lastSeq, lastEventAt: new Date().toISOString(), running: dispatcher.inFlight });
      },
    });

    let stopReason: string | null = null;
    const stop = (why: string) => {
      if (stopReason) return;
      stopReason = why;
      stream.stop();
    };
    opts.signal?.addEventListener("abort", () => stop("stopped"), { once: true });
    const onSignal = (sig: NodeJS.Signals) => {
      if (stopReason) {
        log.warn("Exiting now.");
        killAllRuns();
        process.exit(130);
      }
      log.info(`${sig === "SIGINT" ? "\n" : ""}Stopping (${sig}). Unfinished events will be delivered again next time. Press Ctrl-C again to force.`);
      stop(sig);
    };
    if (opts.handleSignals) {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    }

    const end = await stream.run();
    await dispatcher.stop();
    if (!dryRun) await acker.flush();
    if (opts.handleSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }

    if (end.kind === "revoked") return revokedExit(log, status, profileName, profile, end.reason, opts);
    if (end.kind === "fatal") {
      log.error(`The daemon rejected the stream request: ${end.reason}`);
      status.update({ connected: false, stoppedAt: new Date().toISOString(), exitReason: end.reason });
      status.flush();
      return EXIT.revoked;
    }
    status.update({ connected: false, stoppedAt: new Date().toISOString(), exitReason: stopReason ?? "stopped" });
    status.flush();
    log.info("Stopped.");
    return EXIT.ok;
  } finally {
    releaseLock();
  }
}

async function revokedExit(log: ListenLogger, status: StatusWriter, profileName: string, profile: Profile, reason: string, opts: RunListenerOptions): Promise<number> {
  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  log.error(
    `Access revoked: ${safeText(reason, 300)}\n` +
      `This key won't work again. Pair again with: ${NPX} connect ${profile.url}${p} --force\n` +
      `(your listener settings in the profile are kept; restart the listener or its service afterwards)`,
  );
  status.update({ connected: false, stoppedAt: new Date().toISOString(), exitReason: `revoked: ${safeText(reason, 300)}` });
  status.flush();
  // launchd can't be told "don't restart on this exit code": wait a long time first so it doesn't spin.
  if (process.env.AGENTINBOX_SERVICE === "1" && process.platform === "darwin") {
    await new Promise((r) => setTimeout(r, opts.revokedExitDelayMs ?? 15 * 60_000));
  }
  return EXIT.revoked;
}

function printBanner(log: ListenLogger, name: string, profile: Profile, c: EffectiveConfig, dryRun: boolean): void {
  const lines = [
    `${pc.bold("agentinbox listen")} ${pc.gray(`v${version}`)} · profile ${pc.cyan(name)} · agent ${pc.cyan(safeText(profile.agentName))}`,
    `  daemon    ${profile.url}  ${pc.gray(`(consumer ${c.consumer} on ${hostname()})`)}`,
  ];
  if (dryRun) lines.push(`  mode      ${pc.yellow("dry run")}: matching events are printed; nothing runs and the cursor is not advanced`);
  if (c.exec) lines.push(`  exec      ${safeText(c.exec, 300)}`, `  cwd       ${c.cwd}${c.cwdIsDefault ? pc.gray(" (private; --cwd to change)") : ""}`);
  if (c.forward) lines.push(`  forward   ${c.forward.url} ${pc.gray(`(signed, see \`${NPX} listen secret\`)`)}`);
  lines.push(`  events    ${describeFilter(c)}${c.includeBody ? " · with bodies" : ""}`);
  lines.push(`  limits    concurrency ${c.concurrency} · timeout ${c.timeoutSeconds}s · ${c.maxAttempts} attempts`);
  lines.push(pc.gray(`  log       ${logPath(name)}`));
  for (const l of lines) process.stdout.write(`${l}\n`);
  log.debug("listener starting", { profile: name, url: profile.url, consumer: c.consumer, exec: c.exec, forward: c.forward?.url, types: c.types, filter: c.filter });
}
