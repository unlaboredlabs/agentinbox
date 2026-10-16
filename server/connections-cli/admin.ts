import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SESSION_COOKIE, CSRF_HEADER } from "../auth/index.ts";
import { SESSION_MAX_AGE_MS } from "../auth/sessions.ts";
import { sha256 } from "../crypto.ts";
import { type InstanceInfo, runningInstance } from "../instance.ts";

/**
 * The CLI's admin channel to the daemon on this machine (`connections …`, `import`), without the console password.
 *
 * Whoever can write the data directory already holds master.key and the database (`reset-password` relies on the
 * same thing), so the CLI proves it is the admin by writing there: it inserts a one-time admin session (only
 * sha256(token) is stored, like console sessions) that expires after 15 minutes, uses it as the session cookie
 * against the daemon's own /api on loopback, and deletes it when the command ends. Nothing new listens, no
 * token file sits on disk, and the daemon's admin auth (requireAdmin + the CSRF header) is unchanged: every API
 * call is checked, audited and rate-limited exactly like the console's.
 *
 * Console sessions slide forward on use up to SESSION_MAX_AGE_MS after created_at. The CLI's row is written with
 * created_at = expiry − SESSION_MAX_AGE_MS, so that hard limit is the 15-minute expiry and the row can never be
 * extended (see docs/FOLLOWUPS.md: a session kind column would say this directly).
 */

export const CLI_SESSION_TTL_MS = 15 * 60_000;
export const CLI_SESSION_LABEL = "agentinbox CLI (local admin, one-time)";

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export interface AdminChannel {
  /** The daemon's loopback origin, e.g. http://127.0.0.1:8425. */
  readonly baseUrl: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Deletes the one-time session. Idempotent. */
  close(): void;
}

export interface OpenAdminOptions {
  dataDir: string;
  /** Tests: the running instance, instead of reading the lock file. */
  instance?: InstanceInfo | null;
  /** Tests: the daemon origin, instead of deriving it from the instance. */
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: () => number;
}

/** Where the CLI reaches the daemon: its bind address, or loopback when it listens on every interface. */
export function daemonOrigin(instance: Pick<InstanceInfo, "host" | "port">): string {
  const host = instance.host;
  const any = !host || host === "0.0.0.0" || host === "::" || host === "[::]";
  const h = any ? "127.0.0.1" : host.replace(/^\[|\]$/g, "");
  return `http://${h.includes(":") ? `[${h}]` : h}:${instance.port}`;
}

/** Inserts the one-time admin session; returns the token. */
export function createCliSession(dbPath: string, clock: () => number = Date.now): { token: string; remove: () => void } {
  const token = randomBytes(32).toString("base64url");
  const hash = sha256(token);
  const expires = clock() + CLI_SESSION_TTL_MS;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)").run(
      hash,
      new Date(expires - SESSION_MAX_AGE_MS).toISOString(),
      new Date(expires).toISOString(),
      "local-cli",
      CLI_SESSION_LABEL,
    );
  } finally {
    db.close();
  }
  let removed = false;
  return {
    token,
    remove() {
      if (removed) return;
      removed = true;
      try {
        const d = new DatabaseSync(dbPath);
        try {
          d.exec("PRAGMA busy_timeout = 5000");
          d.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hash);
        } finally {
          d.close();
        }
      } catch {
        // It expires on its own within 15 minutes.
      }
    },
  };
}

export function openAdminChannel(opts: OpenAdminOptions): AdminChannel {
  const dbPath = join(opts.dataDir, "agentinbox.db");
  if (!existsSync(dbPath)) {
    throw new Error(
      `No agentinbox data in ${opts.dataDir}. Run this on the machine agentinbox runs on, as the user it runs as ` +
        "(with sudo for a system service), or pass its data directory with --data.",
    );
  }
  const instance = opts.instance === undefined ? runningInstance(opts.dataDir) : opts.instance;
  if (!instance && !opts.baseUrl) throw new Error(`agentinbox isn't running with the data directory ${opts.dataDir}. Start it first (or pass --data).`);
  const baseUrl = opts.baseUrl ?? daemonOrigin(instance!);
  let session: ReturnType<typeof createCliSession>;
  try {
    session = createCliSession(dbPath, opts.clock);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `Can't open ${dbPath}${code ? ` (${code})` : ""}: ${(err as Error).message}. Run this as the user agentinbox runs as (with sudo for a system service).`,
    );
  }
  const onExit = () => session.remove();
  process.once("exit", onExit);
  const doFetch = opts.fetch ?? fetch;
  return {
    baseUrl,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${session.token}`, [CSRF_HEADER]: "1", accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      } catch (err) {
        throw new Error(`Couldn't reach agentinbox at ${baseUrl}: ${(err as Error).message}`);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON: reported below.
      }
      if (!res.ok) {
        const e = (data as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
        throw new AdminApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? `HTTP ${res.status} from ${path}`, e?.hint);
      }
      return data as T;
    },
    close() {
      process.removeListener("exit", onExit);
      session.remove();
    },
  };
}
