// xaq ignores SIGUSR1 (server/server.ts ignoreInspectorSignal): otherwise any same-user process, such as a code
// extension's child, could open xaq's inspector and run code in it. Its own file: no other listener in this process.

import { url } from "node:inspector";
import { describe, expect, it } from "vitest";
import { ignoreInspectorSignal } from "../server/server.ts";

describe("SIGUSR1", () => {
  it("doesn't open xaq's inspector once the server has started", async () => {
    ignoreInspectorSignal();
    ignoreInspectorSignal(); // idempotent
    expect(process.listenerCount("SIGUSR1")).toBe(1);
    process.kill(process.pid, "SIGUSR1");
    await new Promise((r) => setTimeout(r, 300));
    expect(url()).toBeUndefined();
  });
});
