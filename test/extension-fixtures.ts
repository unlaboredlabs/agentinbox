// Extension fixtures for tests: copies of the xaq-extensions repo's manifests (test/fixtures/extensions/<name>/
// xaq-extension.json; refresh them when the repo's change) and a stub of B1's extension store.

import { readFileSync } from "node:fs";
import type { ExtensionPin, ExtensionStore, InstalledExtension } from "../server/extensions/store.ts";
import type { Manifest } from "../server/extensions/manifest.ts";
import { useExtensionStore } from "../server/integrations/index.ts";

export const FIXTURE_EXTENSIONS = ["notion", "t3code", "brightspace"] as const;
export type FixtureExtension = (typeof FIXTURE_EXTENSIONS)[number];

/** The parsed manifest JSON, as the repo has it. */
export function fixtureManifest(name: FixtureExtension): Manifest {
  return JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/xaq-extension.json`, import.meta.url), "utf8")) as Manifest;
}

export function fixtureExtension(name: FixtureExtension, over: Partial<InstalledExtension> = {}): InstalledExtension {
  const manifest = fixtureManifest(name);
  return {
    name,
    kind: manifest.kind,
    version: manifest.version,
    source: "registry:wynn-dev/xaq-extensions",
    commit: "1111111111111111111111111111111111111111",
    integrity: `sha256-${Buffer.alloc(32, name.length).toString("base64")}`,
    official: true,
    installDir: `/nonexistent/extensions/${name}`,
    manifest,
    installedAt: "2026-10-16T00:00:00.000Z",
    ...over,
  };
}

export interface StubStore extends Pick<ExtensionStore, "list" | "get" | "installPinned"> {
  /** Pins installPinned was called with, in order. */
  installs: ExtensionPin[];
  /** Resolves the pending installPinned calls (with `installable`, they wait for this). */
  release(): void;
}

/**
 * An in-memory store with `installed` extensions. installPinned installs the fixture of that name (when it's
 * `installable`), after `release()` when `hold` is set, and fails otherwise.
 */
export function stubExtensionStore(opts: { installed?: FixtureExtension[]; installable?: FixtureExtension[]; hold?: boolean } = {}): StubStore {
  const have = new Map<string, InstalledExtension>((opts.installed ?? []).map((n) => [n, fixtureExtension(n)]));
  const installs: ExtensionPin[] = [];
  let gate: () => void = () => {};
  const held = opts.hold ? new Promise<void>((r) => (gate = r)) : Promise.resolve();
  return {
    installs,
    release: () => gate(),
    list: () => [...have.values()],
    get: (name) => have.get(name) ?? null,
    async installPinned(pin) {
      installs.push(pin);
      await held;
      if (!(opts.installable as readonly string[] | undefined)?.includes(pin.name)) throw new Error(`no such extension: ${pin.name}`);
      const ext = fixtureExtension(pin.name as FixtureExtension, { commit: pin.commit, integrity: pin.integrity });
      have.set(pin.name, ext);
      return ext;
    },
  };
}

/** Installs the fixture extensions into presets() for this test file; returns the undo. */
export function useFixtureExtensions(names: readonly FixtureExtension[] = FIXTURE_EXTENSIONS): () => void {
  useExtensionStore(stubExtensionStore({ installed: [...names] }));
  return () => useExtensionStore(null);
}
