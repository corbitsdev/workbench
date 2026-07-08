import { readFileSync } from "node:fs";
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Single source of truth for the app version shown on the reconnecting overlay:
// the monorepo root package.json. Injected at build time so the browser bundle
// needs no version endpoint.
const rootPkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // @intx/agent is a server-only package (uses node:path, process, etc).
      // Something in the dep graph pulls it into the browser bundle in dev mode
      // (production tree-shakes it out). Stub it so dev mode doesn't crash.
      "@intx/agent": path.resolve(__dirname, "./src/stubs/intx-agent.ts"),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
