import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts", "server/**/*.test.ts"], environment: "node", testTimeout: 20000, setupFiles: ["test/setup-no-network.ts"] },
});
