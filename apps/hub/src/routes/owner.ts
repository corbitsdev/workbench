import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type GrantStore } from "@intx/authz";
import { OwnerContextResponse } from "@workbench/shared";
import type { HubDb } from "../db";
import { createOwnerGrantGuard } from "../lib/admin-grant";

type OwnerRouteEnv = {
  Variables: { userId: string; ownerPrincipalId: string };
};

export interface CreateOwnerRouterDeps {
  db: HubDb;
  grantStore: GrantStore;
  rootTenantId: string;
}

/**
 * The Owner area's server surface. Mounted on the session-authenticated
 * `/api/v1` app; EVERY route is behind the OWNER grant guard so access is
 * enforced at the hub, not merely hidden in the web nav. Owner is strictly
 * stronger than admin: an ABK Labs owner (owner role, `*`/`*`) passes; a
 * customer admin does not. Governance is scoped to the root (global org) tenant,
 * the same tenant the guard authorizes against.
 */
export function createOwnerRouter(
  deps: CreateOwnerRouterDeps,
): Hono<OwnerRouteEnv> {
  const { db, grantStore, rootTenantId } = deps;
  const router = new Hono<OwnerRouteEnv>();

  router.use(
    "/owner/*",
    createOwnerGrantGuard({ db, grantStore, rootTenantId }),
  );

  // Owner identity/context for the current session. The `/owner` web shell
  // reads this to confirm owner access and learn which root tenant it governs.
  router.get(
    "/owner/context",
    describeRoute({
      description: "Owner identity and the root tenant the owner governs.",
      responses: {
        200: {
          description: "Owner context",
          content: {
            "application/json": {
              schema: resolver(OwnerContextResponse),
            },
          },
        },
      },
    }),
    (c) =>
      c.json({
        tenantId: rootTenantId,
        ownerPrincipalId: c.get("ownerPrincipalId"),
      }),
  );

  return router;
}
