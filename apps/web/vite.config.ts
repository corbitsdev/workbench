// The build lands in apps/web/dist with root-relative asset URLs; point the
// hub's HUB_STATIC_DIR at that directory and the interface is served from the
// hub's own origin, so every /api call is same-origin with no CORS setup.
//
// `vite dev` proxies /api to a locally running hub so the interface can be
// developed against real data without a build step.
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

function manualChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (id.includes("react-dom") || id.includes("react/")) return "react-vendor";
  if (id.includes("@corbits+react-ui") || id.includes("@corbits/react-ui")) {
    return "react-ui";
  }
  if (id.includes("@phosphor-icons/react")) return "icons";
  if (id.includes("@tanstack")) return "query-vendor";
  if (id.includes("yjs")) return "collab-vendor";
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  server: {
    proxy: {
      "/api": process.env.BASE_URL ?? "http://localhost:3000",
    },
  },
});
