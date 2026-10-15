import { randomBytes } from "node:crypto";
import { sha256 } from "../crypto.ts";
import type { Db } from "../db/index.ts";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** Sliding refresh never extends a session past this age: sign in again after 90 days. */
export const SESSION_MAX_AGE_MS = 90 * 24 * 3600_000;
/** Sliding expiry is pushed forward at most once per this interval, to avoid a write per request. */
const REFRESH_AFTER_MS = 24 * 3600_000;

export interface SessionCheck {
  valid: boolean;
  /** The expiry was extended: re-send the cookie so the browser keeps it as long. */
  refreshed: boolean;
}

/** Admin console sessions. Only sha256(token) is stored. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  create(meta: { ip?: string | null; userAgent?: string | null } = {}): string {
    const token = randomBytes(32).toString("base64url");
    const t = this.clock();
    this.db.run(
      "INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)",
      sha256(token),
      new Date(t).toISOString(),
      new Date(t + SESSION_TTL_MS).toISOString(),
      meta.ip ?? null,
      meta.userAgent?.slice(0, 300) ?? null,
    );
    return token;
  }

  check(token: string | undefined | null): SessionCheck {
    if (!token) return { valid: false, refreshed: false };
    const hash = sha256(token);
    const row = this.db.get<{ created_at: string; expires_at: string }>(
      "SELECT created_at, expires_at FROM admin_sessions WHERE token_hash = ?",
      hash,
    );
    if (!row) return { valid: false, refreshed: false };
    const t = this.clock();
    const expires = Date.parse(row.expires_at);
    const hardLimit = Date.parse(row.created_at) + SESSION_MAX_AGE_MS;
    if (!(expires > t) || !(hardLimit > t)) {
      this.db.run("DELETE FROM admin_sessions WHERE token_hash = ?", hash);
      return { valid: false, refreshed: false };
    }
    const next = Math.min(t + SESSION_TTL_MS, hardLimit);
    if (next - expires < REFRESH_AFTER_MS) return { valid: true, refreshed: false };
    this.db.run("UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?", new Date(next).toISOString(), hash);
    return { valid: true, refreshed: true };
  }

  delete(token: string): void {
    this.db.run("DELETE FROM admin_sessions WHERE token_hash = ?", sha256(token));
  }

  /** Revokes every session, optionally keeping one (the caller's own). */
  deleteAll(exceptToken?: string | null): number {
    if (exceptToken) return this.db.run("DELETE FROM admin_sessions WHERE token_hash != ?", sha256(exceptToken)).changes;
    return this.db.run("DELETE FROM admin_sessions").changes;
  }

  pruneExpired(): number {
    return this.db.run("DELETE FROM admin_sessions WHERE expires_at <= ?", new Date(this.clock()).toISOString()).changes;
  }
}
