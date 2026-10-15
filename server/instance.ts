import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NPM_PACKAGE } from "../shared/types.ts";
import type { Config } from "./config.ts";
import { Crypto } from "./crypto.ts";

/**
 * How to run this CLI in printed hints: `npx agentinbox-cli` when run through npx (and in service
 * logs, read by someone who most likely installed that way), else the installed `agentinbox`.
 */
export function cliCommand(args: string): string {
  const viaNpx = process.env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(process.argv[1] ?? "") || process.env.AGENTINBOX_SERVICE === "1";
  return `${viaNpx ? `npx ${NPM_PACKAGE}` : "agentinbox"} ${args}`;
}

// ───────────── Single instance per data directory ─────────────

export interface InstanceInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
}

export const lockPath = (dataDir: string) => join(dataDir, "agentinbox.lock");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(dataDir: string): InstanceInfo | null {
  try {
    const info = JSON.parse(readFileSync(lockPath(dataDir), "utf8")) as InstanceInfo;
    return Number.isInteger(info.pid) && info.pid > 0 ? info : null;
  } catch {
    return null;
  }
}

/** The running instance for this data directory, if any. */
export function runningInstance(dataDir: string): InstanceInfo | null {
  const info = readLock(dataDir);
  return info && isAlive(info.pid) ? info : null;
}

export interface InstanceLock {
  /** Records the bound port (for `reset-password` and error messages). */
  update(port: number): void;
  release(): void;
}

/**
 * Takes `<data>/agentinbox.lock`. Two processes on one data directory would both run ingest and
 * deliver every webhook twice, even on different ports. A lock left by a dead process is replaced.
 */
export function acquireInstanceLock(config: Pick<Config, "dataDir" | "host" | "port">): InstanceLock {
  const file = lockPath(config.dataDir);
  const info: InstanceInfo = { pid: process.pid, host: config.host, port: config.port, startedAt: new Date().toISOString() };
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(info), { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw err;
      const other = runningInstance(config.dataDir);
      if (other) {
        throw new Error(
          `agentinbox is already running with the data directory ${config.dataDir} (pid ${other.pid}${other.port ? `, port ${other.port}` : ""}). ` +
            `Stop it first, or use another --data directory. If no such process exists, delete ${file}.`,
        );
      }
      rmSync(file, { force: true });
    }
  }
  return {
    update(port) {
      info.port = port;
      if (readLock(config.dataDir)?.pid === process.pid) writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
    },
    release() {
      if (readLock(config.dataDir)?.pid === process.pid) rmSync(file, { force: true });
    },
  };
}

// ───────────── Master key guard ─────────────

/** One ciphertext from the database, or null when nothing encrypted is stored. */
function sampleCiphertext(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    const queries = [
      "SELECT refresh_token_enc AS v FROM accounts WHERE refresh_token_enc LIKE 'v1:%' LIMIT 1",
      "SELECT secret_enc AS v FROM webhooks WHERE secret_enc LIKE 'v1:%' LIMIT 1",
      "SELECT json_extract(value, '$.clientSecretEnc') AS v FROM settings WHERE key = 'google.client'",
    ];
    for (const sql of queries) {
      try {
        const v = (db.prepare(sql).get() as { v?: unknown } | undefined)?.v;
        if (typeof v === "string" && v.startsWith("v1:")) return v;
      } catch {
        // Table not created yet.
      }
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Refuses to start with a master key that can't read the stored secrets: a missing master.key would
 * otherwise be regenerated, silently making every refresh token and webhook secret unreadable.
 * `envKey` overrides AGENTINBOX_MASTER_KEY (used by `service install` to check the key it will install).
 */
export function assertMasterKeyUsable(config: Pick<Config, "dbPath" | "masterKeyPath">, envKey = process.env.AGENTINBOX_MASTER_KEY): void {
  const sample = sampleCiphertext(config.dbPath);
  if (!sample) return;
  let raw: string | null = envKey || null;
  const source = raw ? "AGENTINBOX_MASTER_KEY" : config.masterKeyPath;
  if (!raw && existsSync(config.masterKeyPath)) raw = readFileSync(config.masterKeyPath, "utf8").trim();
  if (!raw) {
    throw new Error(
      `${config.dbPath} holds encrypted secrets, but there is no master key: ${config.masterKeyPath} is missing and AGENTINBOX_MASTER_KEY is not set. ` +
        "Restore master.key from your backup (or set AGENTINBOX_MASTER_KEY to the key used before). " +
        "agentinbox won't create a new key, because the stored Google tokens and secrets could never be read again.",
    );
  }
  try {
    new Crypto(Buffer.from(raw, "base64")).decrypt(sample);
  } catch {
    throw new Error(
      `The master key from ${source} can't decrypt the secrets stored in ${config.dbPath}. ` +
        "Use the key this data directory was created with (master.key from your backup, or the previous AGENTINBOX_MASTER_KEY).",
    );
  }
}
