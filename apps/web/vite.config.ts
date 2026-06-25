import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
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
