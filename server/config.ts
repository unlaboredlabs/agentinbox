import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  dataDir: string;
  dbPath: string;
  masterKeyPath: string;
  host: string;
  port: number;
  /** Dev mode: console served by Vite on :5173, server only serves /api, /mcp, /oauth. */
  dev: boolean;
  /** Honor X-Forwarded-For / X-Forwarded-Proto (behind a reverse proxy). */
  trustProxy: boolean;
  /** Running under `agentinbox service install` (set via AGENTINBOX_SERVICE=1 in the unit/plist). */
  service: boolean;
  version: string;
  /**
   * Base URLs for Google APIs. Overridable so tests can point at test/fake-google.ts.
   * Defaults: https://oauth2.googleapis.com, https://accounts.google.com, https://gmail.googleapis.com, https://pubsub.googleapis.com
   */
  google: { oauthBase: string; authBase: string; gmailBase: string; pubsubBase: string };
}

export interface ConfigInput {
  dataDir?: string;
  host?: string;
  port?: number;
  dev?: boolean;
}

export const DEFAULT_PORT = 8425;

export function loadConfig(input: ConfigInput = {}, version = "0.0.0"): Config {
  const dataDir = resolve(input.dataDir ?? process.env.AGENTINBOX_DATA ?? join(homedir(), ".agentinbox"));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  restrictDir(dataDir);
  return {
    dataDir,
    dbPath: join(dataDir, "agentinbox.db"),
    masterKeyPath: join(dataDir, "master.key"),
    host: input.host ?? process.env.HOST ?? "0.0.0.0",
    port: input.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT),
    dev: input.dev ?? false,
    trustProxy: process.env.TRUST_PROXY === "1",
    service: process.env.AGENTINBOX_SERVICE === "1",
    version,
    google: {
      oauthBase: process.env.AGENTINBOX_GOOGLE_OAUTH_BASE ?? "https://oauth2.googleapis.com",
      authBase: process.env.AGENTINBOX_GOOGLE_AUTH_BASE ?? "https://accounts.google.com",
      gmailBase: process.env.AGENTINBOX_GOOGLE_GMAIL_BASE ?? "https://gmail.googleapis.com",
      pubsubBase: process.env.AGENTINBOX_GOOGLE_PUBSUB_BASE ?? "https://pubsub.googleapis.com",
    },
  };
}

/** An existing data dir may be group/world accessible (umask, manual mkdir): tighten it to owner-only. */
function restrictDir(dir: string): void {
  try {
    if (process.platform !== "win32" && statSync(dir).mode & 0o077) {
      chmodSync(dir, 0o700);
      process.stderr.write(`agentinbox: restricted ${dir} to owner-only access (it was readable by other users).\n`);
    }
  } catch {
    // Not ours to change; the files inside are still created owner-only.
  }
}
