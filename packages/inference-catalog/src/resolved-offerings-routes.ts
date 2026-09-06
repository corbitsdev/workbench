// The tenant-owned `GET .../catalog/offerings` route only ever lists rows a
// tenant planted directly on itself; it has no way to show offerings a
// tenant inherits from an ancestor tenant. `listVisibleOfferings`
// (`@intx/db`) already computes that resolved, inheritance-aware view for
// the hub's own workflow deployer — this route exposes the same view over
// HTTP so an out-of-process caller (`workbench seed`, in particular) can
// deploy against exactly what the hub itself would deploy against.
//
// Takes a `listOfferings` port rather than a `db` handle, same as
// `workflow-catalog-routes.ts`, so the route is testable with literals.
import { Hono } from "hono";
import type { ResolvedOffering } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

export type CreateResolvedOfferingsRoutesDeps = {
  readonly listOfferings: (
    tenantId: string,
  ) => Promise<readonly ResolvedOffering[]>;
  readonly requireGrant: RequireGrant;
};

export function createResolvedOfferingsRoutes(
  deps: CreateResolvedOfferingsRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("model-offering:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const resolved = [...(await deps.listOfferings(tenant.id))].sort(
      (a, b) => a.offering.priority - b.offering.priority,
    );
    return c.json({
      offerings: resolved.map((entry) => ({
        id: entry.offering.id,
        priority: entry.offering.priority,
        modelId: entry.offering.modelId,
        providerId: entry.offering.providerId,
        origin: entry.origin,
      })),
    });
  });

  return app;
}
