import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type GrantStore } from "@intx/authz";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  MEMBER_ROLE_NAME,
  OwnerContextResponse,
  OwnerSetupResponse,
  OwnerWorkflowsResponse,
  OwnerWorkflowState,
  OwnerWorkflowToggle,
  WORKFLOW_RUN_ACTION,
  workflowRunResource,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { createOwnerGrantGuard } from "../lib/admin-grant";
import { recordAudit } from "../services/admin-audit";

const { tenant, role, grant } = intxSchema;

// The org member role is the tenant's baseline run policy (see the CL-2885 run
// gate): a `deny` grant on it for `workflow:<kind>`/`run` disables that kind.
async function memberRoleId(
  db: HubDb,
  tenantId: string,
): Promise<string | null> {
  const row = await db.query.role.findFirst({
    where: and(
      eq(role.tenantId, tenantId),
      eq(role.name, MEMBER_ROLE_NAME),
      eq(role.isSystem, true),
    ),
    columns: { id: true },
  });
  return row?.id ?? null;
}

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

  // Deployed workflow kinds with their run-enablement state. `enabled` is false
  // when the org member role holds a `deny` for that kind (or `workflow:*`) —
  // the same signal the CL-2885 run gate enforces.
  router.get(
    "/owner/workflows",
    describeRoute({
      description:
        "Deployed workflow kinds and whether each is enabled to run.",
      responses: {
        200: {
          description: "Owner workflows",
          content: {
            "application/json": { schema: resolver(OwnerWorkflowsResponse) },
          },
        },
      },
    }),
    async (c) => {
      const deployments = await db.query.workflowRun.findMany({
        where: and(
          eq(workflowRun.tenantId, rootTenantId),
          isNotNull(workflowRun.deploymentId),
          isNull(workflowRun.deletedAt),
        ),
        columns: { kind: true },
      });
      const kinds = [...new Set(deployments.map((d) => d.kind))].sort();

      const roleId = await memberRoleId(db, rootTenantId);
      const denyRows = roleId
        ? await db.query.grant.findMany({
            where: and(
              eq(grant.roleId, roleId),
              eq(grant.action, WORKFLOW_RUN_ACTION),
              eq(grant.effect, "deny"),
            ),
            columns: { resource: true },
          })
        : [];
      const deniedResources = new Set(denyRows.map((g) => g.resource));
      const wildcardDenied = deniedResources.has(workflowRunResource("*"));

      return c.json({
        workflows: kinds.map((kind) => ({
          kind,
          enabled:
            !wildcardDenied && !deniedResources.has(workflowRunResource(kind)),
        })),
      });
    },
  );

  // Toggle a workflow's run-enablement for the workbench. Disable = write a
  // member-role `deny` for `workflow:<kind>`/`run`; enable = remove it. Owner
  // enable/disable is grant CRUD on the org member role (the tenant baseline).
  router.put(
    "/owner/workflows/:kind",
    describeRoute({
      description: "Enable or disable a workflow kind for the workbench.",
      responses: {
        200: {
          description: "Updated workflow state",
          content: {
            "application/json": { schema: resolver(OwnerWorkflowState) },
          },
        },
      },
    }),
    async (c) => {
      const kind = c.req.param("kind");
      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = OwnerWorkflowToggle(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `invalid body: ${parsed.summary}` }, 400);
      }

      const roleId = await memberRoleId(db, rootTenantId);
      if (!roleId) {
        return c.json({ error: "Workbench member role not found" }, 404);
      }
      const resource = workflowRunResource(kind);
      const actor = c.get("ownerPrincipalId");
      const now = new Date();

      if (parsed.enabled) {
        await db
          .delete(grant)
          .where(
            and(
              eq(grant.roleId, roleId),
              eq(grant.resource, resource),
              eq(grant.action, WORKFLOW_RUN_ACTION),
              eq(grant.effect, "deny"),
            ),
          );
        void recordAudit({
          db,
          tenantId: rootTenantId,
          action: "grant_revoked",
          actorPrincipalId: actor,
          resource,
          detail: { kind, capability: "workflow-run" },
        });
      } else {
        const existing = await db.query.grant.findFirst({
          where: and(
            eq(grant.roleId, roleId),
            eq(grant.resource, resource),
            eq(grant.action, WORKFLOW_RUN_ACTION),
            eq(grant.effect, "deny"),
          ),
          columns: { id: true },
        });
        if (!existing) {
          await db.insert(grant).values({
            id: generateId("grant"),
            tenantId: rootTenantId,
            roleId,
            resource,
            action: WORKFLOW_RUN_ACTION,
            effect: "deny",
            origin: "system",
            createdAt: now,
            updatedAt: now,
          });
          void recordAudit({
            db,
            tenantId: rootTenantId,
            action: "grant_created",
            actorPrincipalId: actor,
            resource,
            detail: { kind, capability: "workflow-run", effect: "deny" },
          });
        }
      }

      return c.json({ kind, enabled: parsed.enabled });
    },
  );

  return router;
}
