import { readFileSync, writeFileSync } from "node:fs";
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export function hubProxyRewrites(hubUpstreamUrl: string | undefined): {
  source: string;
  destination: string;
}[] {
  const hub = hubUpstreamUrl?.trim().replace(/\/+$/, "");
  const rewrites: { source: string; destination: string }[] = [];
  if (hub) {
    rewrites.push({
      source: "/api/:path*",
      destination: `${hub}/api/:path*`,
    });
    rewrites.push({
      source: "/sidecar/:path*",
      destination: `${hub}/sidecar/:path*`,
    });
  }
  rewrites.push({ source: "/(.*)", destination: "/index.html" });
  return rewrites;
}

function applyVercelHubProxyRewrites(): void {
  const hub = process.env["HUB_UPSTREAM_URL"];
  if (process.env["VERCEL"] === "1" && !hub?.trim()) {
    throw new Error(
      "HUB_UPSTREAM_URL must be set on Vercel (Railway hub origin) so /api is proxied same-origin for OAuth.",
    );
  }
  const vercelJsonPath = path.resolve(__dirname, "../../vercel.json");
  const config = JSON.parse(readFileSync(vercelJsonPath, "utf8")) as Record<
    string,
    unknown
  >;
  config["rewrites"] = hubProxyRewrites(hub);
  writeFileSync(vercelJsonPath, `${JSON.stringify(config, null, 2)}\n`);
}

const VERCEL_MIDDLEWARE_SOURCE = `export const config = {
  matcher: ["/api/:path*", "/sidecar/:path*"],
};

export default async function middleware(request: Request): Promise<Response> {
  const hub = process.env["HUB_UPSTREAM_URL"]?.trim().replace(/\\/$/, "");
  if (!hub) {
    return new Response("HUB_UPSTREAM_URL is not configured", { status: 500 });
  }

  const incoming = new URL(request.url);
  const target = \`\${hub}\${incoming.pathname}\${incoming.search}\`;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD" ? undefined : request.body;

  return fetch(target, {
    method,
    headers,
    body,
    redirect: "manual",
  });
}
`;

export function writeVercelMiddlewareFile(): void {
  const middlewarePath = path.resolve(__dirname, "../../middleware.ts");
  writeFileSync(middlewarePath, VERCEL_MIDDLEWARE_SOURCE);
}

if (process.env["CONFIGURE_VERCEL_HUB_PROXY"] === "1") {
  applyVercelHubProxyRewrites();
  writeVercelMiddlewareFile();
}

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
