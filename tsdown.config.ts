import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "server/cli.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  clean: false,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  copy: [{ from: "server/skill/SKILL.md", to: "dist/skill" }],
});
