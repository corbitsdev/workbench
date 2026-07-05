import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import type { AssetService } from "@intx/hub-sessions";
import {
  AgentDefinitionsResponse,
  AuditListResponse,
  PrincipalGrantsResponse,
  PrincipalListResponse,
  RoleListResponse,
  ToolDefinitionsResponse,
  WorkflowDefinitionsResponse,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { createAdminGrantGuard } from "../lib/admin-grant";
import {
  listAvailableToolSummaries,
  resolveToolVersions,
} from "../lib/tenant-tools";
import { listAuditRecords, recordAudit } from "../services/admin-audit";
import {
  assignRole,
  findAdminRoleId,
  getPrincipalGrants,
  listAgentDefinitions,
  listTenantPrincipals,
  listTenantRoles,
  listWorkflowDefinitions,
  principalExistsInTenant,
  removeRole,
} from "../services/admin-governance";

const log = getLogger(["api", "admin"]);

const ErrorResponse = type({ error: "string" });
const OkResponse = type({ ok: "boolean" });

type AdminRouteEnv = {
  Variables: { userId: string; userName: string; adminPrincipalId: string };
};

export interface CreateAdminRouterDeps {
  db: HubDb;
  grantStore: GrantStore;
  assetService: AssetService;
  rootTenantId: string;
}

/**
 * The Admin area's server surface (CL-2719/2720/2721/2735/2736). Mounted on the
 * session-authenticated `/api/v1` app; EVERY route is behind the admin grant
 * guard (`createAdminGrantGuard`) so access is enforced at the hub, not merely
 * hidden in the web nav. The guard resolves the caller's root-tenant principal,
 * authorizes it via Interchange's native grant model, and stashes the admin
 * principal id on the context for mutation audit records.
 *
 * The only enforced mutation is admin role assignment (elevate/demote). Every
 * `/admin/*` route gates on full admin, so per-capability grant sharing would
 * gate nothing in-product — it is deferred to CL-2799. All governance is scoped
 * to the root (global org) tenant.
 */
export function createAdminRouter(
  deps: CreateAdminRouterDeps,
): Hono<AdminRouteEnv> {
  const { db, grantStore, assetService, rootTenantId } = deps;
  const router = new Hono<AdminRouteEnv>();

  router.use(
    "/admin/*",
    createAdminGrantGuard({ db, grantStore, rootTenantId }),
  );

  // ─── Definition browsers (CL-2720) ───────────────────────────────

  router.get(
    "/admin/definitions/workflows",
    describeRoute({
      tags: ["Admin"],
      summary: "List active workflow deployments (read-only)",
      description:
        "Every live workflow deployment in the root tenant with its deploy-time provenance (version, git sha, label). Read-only; editing/publishing stays in the admin CLI.",
      responses: {
        200: {
          description: "Active workflow definitions",
          content: {
            "application/json": {
              schema: resolver(WorkflowDefinitionsResponse),
            },
          },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const definitions = await listWorkflowDefinitions(db, rootTenantId);
      return c.json({ definitions });
    },
  );

  router.get(
    "/admin/definitions/agents",
    describeRoute({
      tags: ["Admin"],
      summary: "List agent definitions (read-only)",
      description:
        "The root tenant's agent definitions (name, version, status). Read-only.",
      responses: {
        200: {
          description: "Agent definitions",
          content: {
            "application/json": { schema: resolver(AgentDefinitionsResponse) },
          },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const definitions = await listAgentDefinitions(db, rootTenantId);
      return c.json({ definitions });
    },
  );

  router.get(
    "/admin/definitions/tools",
    describeRoute({
      tags: ["Admin"],
      summary: "List tool definitions (read-only)",
      description:
        "The tools the root tenant can run, with resolved registry versions. Read-only.",
      responses: {
        200: {
          description: "Tool definitions",
          content: {
            "application/json": { schema: resolver(ToolDefinitionsResponse) },
          },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const summaries = await listAvailableToolSummaries(db, rootTenantId);
      const versionByTool = await resolveToolVersions(
        db,
        rootTenantId,
        summaries.map((s) => s.name),
        assetService,
      );
      const definitions = summaries.map((s) => ({
        ...s,
        version: versionByTool.get(s.name) ?? null,
      }));
      return c.json({ definitions });
    },
  );

  // ─── Principals + grants (CL-2721) ───────────────────────────────

  router.get(
    "/admin/principals",
    describeRoute({
      tags: ["Admin"],
      summary: "List principals (humans + agent instances) with roles",
      description:
        "Every principal in the root tenant — human members and agent-instance synthetic principals — with each one's role assignments and whether it is an admin.",
      responses: {
        200: {
          description: "Principals",
          content: {
            "application/json": { schema: resolver(PrincipalListResponse) },
          },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const principals = await listTenantPrincipals(db, rootTenantId);
      return c.json({ principals });
    },
  );

  router.get(
    "/admin/principals/:principalId/grants",
    describeRoute({
      tags: ["Admin"],
      summary: "A principal's resolved grants (including role-based)",
      description:
        "The principal's role assignments plus every grant `collectGrants` resolves — direct grants and grants inherited from assigned roles (the native role→grant expansion). Read-only.",
      parameters: [
        {
          name: "principalId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Resolved grants",
          content: {
            "application/json": { schema: resolver(PrincipalGrantsResponse) },
          },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const principalId = c.req.param("principalId");
      const result = await getPrincipalGrants(
        db,
        grantStore,
        rootTenantId,
        principalId,
      );
      return c.json(result);
    },
  );

  router.get(
    "/admin/roles",
    describeRoute({
      tags: ["Admin"],
      summary: "List roles in the tenant",
      responses: {
        200: {
          description: "Roles",
          content: {
            "application/json": { schema: resolver(RoleListResponse) },
          },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const roles = await listTenantRoles(db, rootTenantId);
      return c.json({ roles });
    },
  );

  // ─── Audit (CL-2735) ─────────────────────────────────────────────

  router.get(
    "/admin/audit",
    describeRoute({
      tags: ["Admin"],
      summary: "Compliance audit log (cross-principal reads + role changes)",
      description:
        "Newest-first audit records: who read another principal's timeline, and every admin role change, with resolved actor/target names.",
      responses: {
        200: {
          description: "Audit records",
          content: {
            "application/json": { schema: resolver(AuditListResponse) },
          },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const records = await listAuditRecords(db, rootTenantId);
      return c.json({ records });
    },
  );

  // ─── Admin role management (CL-2736) ─────────────────────────────

  router.post(
    "/admin/principals/:principalId/elevate",
    describeRoute({
      tags: ["Admin"],
      summary: "Elevate a principal to admin",
      description:
        "Assign the `admin` system role to a principal. They inherit every admin capability via the role's wildcard grants (native role→grant expansion). Audit-logged.",
      parameters: [
        {
          name: "principalId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Principal elevated",
          content: { "application/json": { schema: resolver(OkResponse) } },
        },
        404: {
          description: "Unknown principal or no admin role in tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const principalId = c.req.param("principalId");
      if (!(await principalExistsInTenant(db, rootTenantId, principalId))) {
        return c.json({ error: "Unknown principal" }, 404);
      }
      const roleId = await findAdminRoleId(db, rootTenantId);
      if (!roleId) {
        return c.json({ error: "Admin role not found in tenant" }, 404);
      }
      await assignRole(db, rootTenantId, principalId, roleId);
      void recordAudit({
        db,
        tenantId: rootTenantId,
        action: "role_assigned",
        actorPrincipalId: c.get("adminPrincipalId"),
        targetPrincipalId: principalId,
        resource: "role:admin",
        detail: { roleId, elevate: true },
      });
      log.info("admin elevated principal", {
        actor: c.get("adminPrincipalId"),
        principalId,
      });
      return c.json({ ok: true });
    },
  );

  router.post(
    "/admin/principals/:principalId/demote",
    describeRoute({
      tags: ["Admin"],
      summary: "Remove admin from a principal",
      description:
        "Remove the `admin` system role from a principal (the counterpart to elevate — no ratchet-only). Audit-logged.",
      parameters: [
        {
          name: "principalId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Principal demoted",
          content: { "application/json": { schema: resolver(OkResponse) } },
        },
        404: {
          description: "Unknown principal or no admin role in tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const principalId = c.req.param("principalId");
      if (!(await principalExistsInTenant(db, rootTenantId, principalId))) {
        return c.json({ error: "Unknown principal" }, 404);
      }
      const roleId = await findAdminRoleId(db, rootTenantId);
      if (!roleId) {
        return c.json({ error: "Admin role not found in tenant" }, 404);
      }
      await removeRole(db, principalId, roleId);
      void recordAudit({
        db,
        tenantId: rootTenantId,
        action: "role_removed",
        actorPrincipalId: c.get("adminPrincipalId"),
        targetPrincipalId: principalId,
        resource: "role:admin",
        detail: { roleId, demote: true },
      });
      log.info("admin demoted principal", {
        actor: c.get("adminPrincipalId"),
        principalId,
      });
      return c.json({ ok: true });
    },
  );

  return router;
}
