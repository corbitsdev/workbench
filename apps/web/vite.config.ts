// The build lands in apps/web/dist with root-relative asset URLs; point the
// hub's HUB_STATIC_DIR at that directory and the interface is served from the
// hub's own origin, so every /api call is same-origin with no CORS setup.
//
// `vite dev` proxies /api to a locally running hub so the interface can be
// developed against real data without a build step.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": process.env.BASE_URL ?? "http://localhost:3000",
    },
  },
});
