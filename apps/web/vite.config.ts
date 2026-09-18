// The build lands in apps/web/dist with root-relative asset URLs; point the
// hub's HUB_STATIC_DIR at that directory and the interface is served from the
// hub's own origin, so every /api call is same-origin with no CORS setup.
//
// `vite dev` proxies /api to a locally running hub so the interface can be
// developed against real data without a build step.
import { execFileSync } from "node:child_process";
import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const myraDir = path.resolve(__dirname, "..", "..", "agents", "myra");

// Myra's deploy source is a bundle of her workflow entry, generated (and
// gitignored) rather than committed; it has to exist before Vite resolves
// `@corbits/myra/bundle`. Built in a `bun` subprocess because `Bun.build`
// is unavailable in the Node process Vite itself runs in.
function myraWorkflowBundle(): Plugin {
  return {
    name: "myra-workflow-bundle",
    buildStart() {
      execFileSync("bun", ["run", path.join(myraDir, "scripts", "build-bundle.ts")], {
        cwd: myraDir,
        stdio: "inherit",
      });
    },
  };
}

function manualChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (id.includes("react-dom") || id.includes("react/")) return "react-vendor";
  if (id.includes("@corbits+react-ui") || id.includes("@corbits/react-ui")) {
    return "react-ui";
  }
  if (id.includes("@phosphor-icons/react")) return "icons";
  if (id.includes("@tanstack")) return "query-vendor";
  return undefined;
}

const hubOrigin = process.env.BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [myraWorkflowBundle(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: hubOrigin,
        // Better Auth trusts only the hub's own origin, so the dev server
        // presents itself as the hub rather than as localhost:5173.
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("origin", hubOrigin));
        },
      },
    },
  },
});
