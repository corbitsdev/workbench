// Tenant-scoped bench model policy: what this bench will and won't spend on
// inference. Gated on the same catalog-administration grants the platform
// already uses for offerings, since that is exactly what a policy constrains.
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { BenchModelPolicyPatch } from "./policy";
import type { BenchModelPolicyStore } from "./store";

export type CreateBenchModelPolicyRoutesDeps = {
  store: BenchModelPolicyStore;
  requireGrant: RequireGrant;
};

export function createBenchModelPolicyRoutes(
  deps: CreateBenchModelPolicyRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("model-offering:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    return c.json({ policy: await deps.store.getPolicy(tenant.id) });
  });

  app.patch("/", deps.requireGrant("model-offering:*", "manage"), async (c) => {
    const tenant = c.get("tenant");
    const raw = await c.req.json().catch(() => undefined);
    const patch = BenchModelPolicyPatch(raw);
    if (patch instanceof type.errors) {
      return c.json(
        {
          error: {
            code: "bad_request",
            message: `invalid body: ${patch.summary}`,
          },
        },
        400,
      );
    }
    return c.json({ policy: await deps.store.patchPolicy(tenant.id, patch) });
  });

  return app;
}
