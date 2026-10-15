import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../server/config.ts";
import type { AppContext } from "../server/context.ts";
import { createAppContext, type ServiceOverrides, stopServices } from "../server/wire.ts";

/** A config rooted in a fresh temp data dir. Pass `google` to point at test/fake-google.ts. */
export function testConfig(patch: Partial<Config> = {}): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "agentinbox-test-"));
  return { ...loadConfig({ dataDir, host: "127.0.0.1", port: 0 }, "0.0.0-test"), ...patch };
}

/** A fully wired context on a temp database. Call `dispose()` in afterEach/afterAll. */
export function testContext(overrides: ServiceOverrides = {}, patch: Partial<Config> = {}) {
  const ctx: AppContext = createAppContext(testConfig(patch), overrides);
  return {
    ctx,
    async dispose() {
      await stopServices(ctx);
      rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}
