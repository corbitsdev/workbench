import type { MiddlewareHandler } from "hono";
import { getLogger } from "@intx/log";
import { isDraining } from "./drain-state";

const log = getLogger(["lib", "drain-guard"]);

/**
 * Outer middleware for the sidecar WebSocket upgrade route. Interchange's
 * `createSidecarRoutes` owns `/api/sidecars/ws` and cannot be changed here, so
 * this is registered ahead of it (`app.use` before `app.route`) and short-
 * circuits every request once `beginDrain()` has fired — refusing the
 * upgrade with 503 rather than letting a draining process accept (or hang
 * on) a new sidecar connection. Existing connections and in-flight drain
 * work are untouched; this only gates NEW upgrades.
 */
export function createSidecarWsDrainGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (isDraining()) {
      log.info("Refusing sidecar WS upgrade while hub is draining", {
        path: c.req.path,
      });
      return c.json({ error: "hub draining" }, 503);
    }
    await next();
  };
}
