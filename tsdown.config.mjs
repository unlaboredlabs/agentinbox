// Plain JS so tsdown can load it on Node 22 without a TypeScript loader.
import { defineConfig } from "tsdown";

export default defineConfig({
  // content-worker runs email cleaning off the main thread (server/mail/pool.ts loads it next to cli.js).
  entry: { cli: "server/cli.ts", "content-worker": "server/mail/content-worker.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // Keep the `bin` path stable (dist/cli.js) and only clean server output, so dist/web survives.
  fixedExtension: false,
  clean: ["dist/*.js", "dist/*.js.map", "dist/skill"],
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  copy: [{ from: "server/skill/SKILL.md", to: "dist/skill" }],
});
