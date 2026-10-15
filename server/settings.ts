import type { GoogleAppType, IngestMode, PubsubState, Settings } from "../shared/types.ts";
import type { Bus } from "./bus.ts";
import type { Config } from "./config.ts";
import { type Db, json } from "./db/index.ts";
import { badRequest } from "./util/errors.ts";

/**
 * Internal key/value state kept in the `settings` table next to the user-facing Settings.
 * Owners: google.* and pubsub → server/google, admin.* → server/auth.
 */
export interface InternalState {
  "google.client": {
    clientId: string;
    /** AES-GCM ciphertext (ctx.crypto). */
    clientSecretEnc: string | null;
    projectId: string;
    appType: GoogleAppType;
  };
  /** Pub/Sub resources and health. `mode` is not stored here: it is Settings.ingestMode. */
  pubsub: Omit<PubsubState, "mode"> & {
    /** Account whose OAuth token provisions and pulls the subscription (it needs IAM on the project). */
    principalAccountId: string | null;
  };
  "admin.passwordHash": string;
}

export type InternalKey = keyof InternalState;

const USER_KEY = "settings";

export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
    private readonly config: Config,
  ) {}

  defaults(): Settings {
    return {
      publicUrl: defaultPublicUrl(this.config.host, this.config.port),
      ingestMode: "poll",
      pollIntervalSeconds: 30,
      maxBodyChars: 20_000,
      retentionDays: 30,
      approvalTtlHours: 72,
      webhookAllowlist: ["localhost", "127.0.0.0/8", "::1"],
    };
  }

  get(): Settings {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", USER_KEY);
    return { ...this.defaults(), ...json.parse<Partial<Settings>>(row?.value, {}) };
  }

  /** Validates, persists and broadcasts. Throws HttpError(400) on invalid input. */
  update(patch: Partial<Settings>): Settings {
    const next = validate({ ...this.get(), ...stripUndefined(patch) });
    this.write(USER_KEY, next);
    this.bus.emit("settings", next);
    return next;
  }

  /** The OAuth redirect URI and MCP snippets are derived from this. Never has a trailing slash. */
  publicUrl(): string {
    return this.get().publicUrl;
  }

  getState<K extends InternalKey>(key: K): InternalState[K] | null {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? json.parse<InternalState[K] | null>(row.value, null) : null;
  }

  setState<K extends InternalKey>(key: K, value: InternalState[K]): void {
    this.write(key, value);
  }

  deleteState(key: InternalKey): void {
    this.db.run("DELETE FROM settings WHERE key = ?", key);
  }

  private write(key: string, value: unknown): void {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      json.str(value),
    );
  }
}

const INGEST_MODES: IngestMode[] = ["pubsub", "poll"];

function validate(s: Settings): Settings {
  let url: URL;
  try {
    url = new URL(s.publicUrl);
  } catch {
    throw badRequest("Public URL must be a full URL", "For example https://mail.example.com or http://localhost:8425");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw badRequest("Public URL must use http or https");
  if (url.search || url.hash) throw badRequest("Public URL must not contain a query or fragment");
  const int = (v: number, name: string, min: number, max: number) => {
    if (!Number.isInteger(v) || v < min || v > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`);
    return v;
  };
  if (!INGEST_MODES.includes(s.ingestMode)) throw badRequest("Ingest mode must be pubsub or poll");
  const allowlist = Array.isArray(s.webhookAllowlist) ? s.webhookAllowlist.map((h) => String(h).trim()).filter(Boolean) : null;
  if (!allowlist || allowlist.length > 100 || allowlist.some((h) => h.length > 253 || /\s/.test(h))) {
    throw badRequest("Webhook allowlist must be a list of hostnames, IPs or CIDRs");
  }
  return {
    publicUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    ingestMode: s.ingestMode,
    pollIntervalSeconds: int(s.pollIntervalSeconds, "Poll interval", 5, 3600),
    maxBodyChars: int(s.maxBodyChars, "Max body characters", 0, 1_000_000),
    retentionDays: int(s.retentionDays, "Retention", 1, 3650),
    approvalTtlHours: int(s.approvalTtlHours, "Approval expiry", 1, 24 * 30),
    webhookAllowlist: [...new Set(allowlist)],
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * localhost when bound to all interfaces or to loopback (Google accepts http://localhost redirects);
 * otherwise the specific address or name the operator chose with --host.
 */
export function defaultPublicUrl(host: string, port: number): string {
  const h = host.trim().toLowerCase();
  const local = !h || h === "0.0.0.0" || h === "::" || h === "localhost" || h === "::1" || /^127\./.test(h);
  if (local) return `http://localhost:${port}`;
  return `http://${h.includes(":") ? `[${h}]` : h}:${port}`;
}
