import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomToken } from "../util/ids.ts";

/**
 * One-time token required to claim a fresh install over the network. It is part of the setup link
 * printed on startup and is persisted (mode 0600) so the link survives restarts and
 * `service install` can show it. Deleted once the instance is claimed.
 */
export const setupTokenPath = (dataDir: string) => join(dataDir, "setup-token");

/** A token as randomToken makes it: letters and digits only. */
const TOKEN = /^[A-Za-z0-9]{8,128}$/;

export function readSetupToken(dataDir: string): string | null {
  try {
    const token = readFileSync(setupTokenPath(dataDir), "utf8").trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Whether a setup-token file is there that we didn't write (the data directory may be shared with another program called xaq). */
function foreignToken(dataDir: string): boolean {
  try {
    return !TOKEN.test(readFileSync(setupTokenPath(dataDir), "utf8").trim());
  } catch {
    return false;
  }
}

export function ensureSetupToken(dataDir: string): string {
  const existing = readSetupToken(dataDir);
  if (existing) return existing;
  if (foreignToken(dataDir)) {
    throw new Error(`${setupTokenPath(dataDir)} already exists and isn't xaq's setup token, so it was left alone. Move it away, or use another --data directory.`);
  }
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
  if (!foreignToken(dataDir)) rmSync(setupTokenPath(dataDir), { force: true });
}
