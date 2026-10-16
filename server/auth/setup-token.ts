import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomToken } from "../util/ids.ts";

/**
 * One-time token required to claim a fresh install over the network. It is part of the setup link
 * printed on startup and is persisted (mode 0600) so the link survives restarts and
 * `service install` can show it. Deleted once the instance is claimed.
 */
export const setupTokenPath = (dataDir: string) => join(dataDir, "setup-token");

export function readSetupToken(dataDir: string): string | null {
  try {
    return readFileSync(setupTokenPath(dataDir), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function ensureSetupToken(dataDir: string): string {
  const existing = readSetupToken(dataDir);
  if (existing) return existing;
  const token = randomToken(24);
  writeFileSync(setupTokenPath(dataDir), token + "\n", { mode: 0o600 });
  return token;
}

/** Replaces any existing token (e.g. after `xaq reset-password`). */
export function regenerateSetupToken(dataDir: string): string {
  deleteSetupToken(dataDir);
  return ensureSetupToken(dataDir);
}

export function deleteSetupToken(dataDir: string): void {
  rmSync(setupTokenPath(dataDir), { force: true });
}
