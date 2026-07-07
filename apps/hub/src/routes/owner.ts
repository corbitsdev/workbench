import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type GrantStore } from "@intx/authz";
import { schema as intxSchema } from "@intx/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { OwnerContextResponse, OwnerSetupResponse } from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { createOwnerGrantGuard } from "../lib/admin-grant";

const { tenant } = intxSchema;

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

  // Read-only view of the workbench's provisioned setup: tenant identity,
  // hierarchy position, and the workflow kinds currently deployed (runnable) in
  // it. Scoped to the org tenant the owner governs.
  router.get(
    "/owner/setup",
    describeRoute({
      description:
        "The workbench's underlying setup: tenant identity, hierarchy, and deployed workflow kinds.",
      responses: {
        200: {
          description: "Owner setup",
          content: {
            "application/json": { schema: resolver(OwnerSetupResponse) },
          },
        },
      },
    }),
    async (c) => {
      const row = await db.query.tenant.findFirst({
        where: eq(tenant.id, rootTenantId),
        columns: { id: true, name: true, slug: true, parentId: true },
      });
      if (!row) {
        return c.json({ error: "Workbench tenant not found" }, 404);
      }
      const deployments = await db.query.workflowRun.findMany({
        where: and(
          eq(workflowRun.tenantId, rootTenantId),
          isNotNull(workflowRun.deploymentId),
          isNull(workflowRun.deletedAt),
        ),
        columns: { kind: true },
      });
      const deployedWorkflowKinds = [
        ...new Set(deployments.map((d) => d.kind)),
      ].sort();
      return c.json({
        tenantId: row.id,
        tenantName: row.name,
        tenantSlug: row.slug,
        parentTenantId: row.parentId,
        deployedWorkflowKinds,
      });
    },
  );

  return router;
}
