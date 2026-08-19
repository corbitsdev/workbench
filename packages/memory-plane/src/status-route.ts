// `GET /api/tenants/:tenantId/memory/status` — tenant-scoped, guarded the
// same way the rest of the settings-facing surface is (`packages/connections`'
// `requireGrant("credential:*", "read")` sibling: here it's the memory
// plane's own `"memory"` resource, matching `@corbits/memory`'s own route
// guards). Read-only: this ticket ships no config-write route.
import { Hono } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import type { LazyMemoryPlane } from "./lazy-plane";

export type MemoryStatusRouteDeps = {
  readonly plane: LazyMemoryPlane;
  readonly requireGrant: RequireGrant;
};

export function createMemoryStatusRoutes(
  deps: MemoryStatusRouteDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.get(
    "/status",
    // A fail-closed safety net for a mis-mounted host or a unit test that
    // never ran the host's own tenant middleware — `requireGrant` reads
    // `principal.id` with no guard of its own, matching
    // `@corbits/memory`'s own `requirePrincipal` convention.
    async (c, next) => {
      if (!c.get("principal") || !c.get("tenant")) {
        return c.json(
          {
            error: {
              code: "principal_required",
              message:
                "No principal on the request context. Mount memory under " +
                "the host's tenant-session middleware.",
            },
          },
          401,
        );
      }
      await next();
    },
    deps.requireGrant("memory", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const status = await deps.plane.describeStatus(tenant.id);
      return c.json(status);
    },
  );
  return app;
}
