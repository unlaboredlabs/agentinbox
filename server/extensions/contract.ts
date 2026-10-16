// TEMPORARY local stand-ins for the parallel writers' parts (docs/EXTENSIONS.md). B2 builds against these until the
// lead asks for a rebase:
// - B1 owns the extension store (server/extensions/store.ts): `InstalledExtension`, `ExtensionPin`, `ExtensionStore`
//   below are its agreed interface, copied verbatim. On rebase: import them from "./store.ts" and delete them here.
// - B3 owns the code-extension host (server/extensions/host/index.ts): `createCodeSource` below is its agreed
//   signature, stubbed. On rebase: import it from "./host/index.ts" and delete it here.

import { type NativeSourceDeps, SourceError, type ToolSource } from "../broker/types.ts";

export interface InstalledExtension {
  name: string;
  kind: "remote" | "code";
  version: string;
  source: string;
  commit: string | null;
  integrity: string;
  official: boolean;
  installDir: string;
  manifest: unknown;
  installedAt: string;
}

export interface ExtensionPin {
  name: string;
  commit: string;
  integrity: string;
}

/** B1's store (subset B2 uses). B1 also calls `reloadPresets()` (server/integrations) after install, update and remove. */
export interface ExtensionStore {
  list(): InstalledExtension[];
  get(name: string): InstalledExtension | null;
  installPinned(pin: ExtensionPin): Promise<InstalledExtension>;
}

/** B3's factory: the ToolSource of a `kind: "code"` extension's connection (a stdio child). Stub: tools unavailable. */
export function createCodeSource(ext: InstalledExtension, deps: NativeSourceDeps): ToolSource {
  return {
    connectionId: deps.connectionId,
    listTools: async () => {
      throw new SourceError("unavailable", `The ${ext.name} extension can't run in this build of xaq yet.`);
    },
    callTool: async () => ({ isError: true, content: [{ type: "text", text: `The ${ext.name} extension can't run in this build of xaq yet.` }] }),
    close: async () => {},
  };
}
