// TEMPORARY stand-in for B3's code-extension host (server/extensions/host/index.ts, docs/EXTENSIONS.md): its agreed
// `createCodeSource` signature, stubbed. B3: import it from "./host/index.ts" in manifest.ts and delete this file.

import { type NativeSourceDeps, SourceError, type ToolSource } from "../broker/types.ts";
import type { InstalledExtension } from "./store.ts";

/** The ToolSource of a `kind: "code"` extension's connection (a stdio child). Stub: tools unavailable. */
export function createCodeSource(ext: InstalledExtension, deps: NativeSourceDeps): ToolSource {
  const message = `The ${ext.name} extension can't run in this build of xaq yet.`;
  return {
    connectionId: deps.connectionId,
    listTools: async () => {
      throw new SourceError("unavailable", message);
    },
    callTool: async () => ({ isError: true, content: [{ type: "text", text: message }] }),
    close: async () => {},
  };
}
