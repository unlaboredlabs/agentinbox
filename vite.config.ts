import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.XAQ_DEV_SERVER ?? process.env.AGENTINBOX_DEV_SERVER ?? "http://127.0.0.1:8425";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: server, changeOrigin: false },
      "/mcp": { target: server, changeOrigin: false },
      "/oauth": { target: server, changeOrigin: false },
      "/skill": { target: server, changeOrigin: false },
      // Not "/agent": that prefix would also catch the console's /agents routes.
      "^/agent(/|$)": { target: server, changeOrigin: false },
      "/health": { target: server, changeOrigin: false },
    },
  },
});
