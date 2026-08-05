import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";

/**
 * Builds the echo route surface: POST echoes the request body back
 * verbatim as text; every other method is refused. The hub mounts the
 * returned router inside the platform's native tenant middleware, so
 * tenant and principal are resolved before any handler here runs.
 */
export function createEchoRoutes(): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.post("/", async (c) => {
    const body = await c.req.text();
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });
  app.all("/", (c) => c.text("method not allowed", 405));
  return app;
}
