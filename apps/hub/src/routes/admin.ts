import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import type { AssetService } from "@workbench/hub-sessions";
import {
  AuditListResponse,
  DefinitionDetailResponse,
  DefinitionListResponse,
  type DefinitionSummary,
  type AdminAuditAction,
  adminAuditActions,
  buildPageInfo,
  PrincipalDetailResponse,
  PrincipalGrantsResponse,
  PrincipalListResponse,
  RoleListResponse,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { createAdminGrantGuard } from "../lib/admin-grant";
import {
  listAvailableToolSummaries,
  resolveToolVersions,
} from "../lib/tenant-tools";
import { loadWorkflowCatalogKinds } from "../lib/workflow-catalog";
import { listAuditRecords, recordAudit } from "../services/admin-audit";
import {
  assignRole,
  findAdminRoleId,
  getPrincipalGrants,
  getTenantPrincipal,
  getWorkflowDeploymentHistory,
  listAgentDefinitionSummaries,
  listTenantPrincipals,
  listTenantRoles,
  listWorkflowDefinitionSummaries,
  principalExistsInTenant,
  removeRole,
} from "../services/admin-governance";

const log = getLogger(["api", "admin"]);

const ErrorResponse = type({ error: "string" });
const OkResponse = type({ ok: "boolean" });

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** Parse a 1-based `page` query param; defaults to 1, floors at 1. */
function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Parse a `limit` query param; defaults to `DEFAULT_PAGE_SIZE`, capped. */
function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

/** Slice an in-memory list to a page. */
function paginate<T>(rows: T[], page: number, limit: number): T[] {
  const start = (page - 1) * limit;
  return rows.slice(start, start + limit);
}

/** Parse an ISO date/time query param; undefined when absent or unparseable. */
function parseDateQuery(raw: string | undefined): Date | undefined {
  if (raw === undefined || raw === "") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

type AdminRouteEnv = {
  Variables: { userId: string; userName: string; adminPrincipalId: string };
};

// Standard pagination query parameters, shared by every paginated admin route's
// OpenAPI description.
const PAGINATION_PARAMS = [
  {
    name: "page",
    in: "query" as const,
    required: false,
    description: "1-based page number (default 1).",
    schema: { type: "integer" as const, minimum: 1 },
  },
  {
    name: "limit",
    in: "query" as const,
    required: false,
    description: `Page size (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`,
    schema: { type: "integer" as const, minimum: 1, maximum: MAX_PAGE_SIZE },
  },
];

// The tenant's available tools as normalized definition summaries. A tool is
// not a versioned/superseded deployment, so its `deploymentCount` is 1 and its
// status is a constant "available".
async function listToolDefinitionSummaries(
  db: HubDb,
  tenantId: string,
  assetService: AssetService,
): Promise<DefinitionSummary[]> {
  const summaries = await listAvailableToolSummaries(db, tenantId);
  const versionByTool = await resolveToolVersions(
    db,
    tenantId,
    summaries.map((s) => s.name),
    assetService,
  );
  return summaries.map((s) => ({
    kind: "tool" as const,
    key: s.name,
    name: s.name,
    version: versionByTool.get(s.name) ?? null,
    status: "available",
    description: s.description || s.providerName,
    deploymentCount: 1,
    createdAt: null,
  }));
}

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

  // ─── Definition browser (CL-2720/2807) ───────────────────────────
  //
  // One combined, paginated, filtered list of the REAL workflow/agent/tool
  // definitions the workbench can run. Ephemeral per-run deploy artifacts (a
  // workflow step, a per-run supervisor) are excluded at the source
  // (`listWorkflowDefinitionSummaries` filters against the embedded catalog
  // allowlist) — the raw per-run dump is gone.

  async function gatherDefinitions(): Promise<DefinitionSummary[]> {
    const allowedKinds = await loadWorkflowCatalogKinds();
    const [workflows, agents, tools] = await Promise.all([
      listWorkflowDefinitionSummaries(db, rootTenantId, allowedKinds),
      listAgentDefinitionSummaries(db, rootTenantId),
      listToolDefinitionSummaries(db, rootTenantId, assetService),
    ]);
    return [...workflows, ...agents, ...tools];
  }

  router.get(
    "/admin/definitions",
    describeRoute({
      tags: ["Admin"],
      summary: "List workflow / agent / tool definitions (paginated, filtered)",
      description:
        "The distinct definitions the root tenant can run — real workflows (grouped by kind with a deployment count; ephemeral per-run supervisor/step deployments excluded), agent definitions, and available tools. Read-only. Filter by `kind`, `status`, and `search`; paginate with `page`/`limit`.",
      parameters: [
        ...PAGINATION_PARAMS,
        {
          name: "kind",
          in: "query",
          required: false,
          description: "Filter by definition kind.",
          schema: { type: "string", enum: ["workflow", "agent", "tool"] },
        },
        {
          name: "status",
          in: "query",
          required: false,
          description: "Filter by status (exact).",
          schema: { type: "string" },
        },
        {
          name: "search",
          in: "query",
          required: false,
          description: "Case-insensitive substring match on name/key.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Definitions page",
          content: {
            "application/json": { schema: resolver(DefinitionListResponse) },
          },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const page = parsePage(c.req.query("page"));
      const limit = parseLimit(c.req.query("limit"));
      const kind = c.req.query("kind");
      const status = c.req.query("status");
      const search = c.req.query("search")?.trim().toLowerCase();

      const all = await gatherDefinitions();
      const filtered = all.filter((d) => {
        if (kind && d.kind !== kind) return false;
        if (status && d.status !== status) return false;
        if (search) {
          const hay = `${d.name} ${d.key}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      });
      const definitions = paginate(filtered, page, limit);
      return c.json({
        definitions,
        pageInfo: buildPageInfo(page, limit, filtered.length),
      });
    },
  );

  router.get(
    "/admin/definitions/:key",
    describeRoute({
      tags: ["Admin"],
      summary: "A single definition with its deployment history",
      description:
        "One workflow/agent/tool definition (identified by `key` + `kind` query) and, for a workflow, every `workflow_run` deployment grouped under it, newest first.",
      parameters: [
        { name: "key", in: "path", required: true, schema: { type: "string" } },
        {
          name: "kind",
          in: "query",
          required: true,
          description: "Definition kind (workflow/agent/tool).",
          schema: { type: "string", enum: ["workflow", "agent", "tool"] },
        },
      ],
      responses: {
        200: {
          description: "Definition detail",
          content: {
            "application/json": { schema: resolver(DefinitionDetailResponse) },
          },
        },
        404: {
          description: "Unknown definition",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not an admin",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const key = c.req.param("key");
      const kind = c.req.query("kind");
      const all = await gatherDefinitions();
      const definition = all.find((d) => d.kind === kind && d.key === key);
      if (!definition) {
        return c.json({ error: "Unknown definition" }, 404);
      }
      const deployments =
        definition.kind === "workflow"
          ? await getWorkflowDeploymentHistory(db, rootTenantId, key)
          : [];
      return c.json({ definition, deployments });
    },
  );

  // ─── Principals + grants (CL-2721/2807) ──────────────────────────

  router.get(
    "/admin/principals",
    describeRoute({
      tags: ["Admin"],
      summary:
        "List principals (humans + agent instances) — paginated/filtered",
      description:
        "Principals in the root tenant — human members and agent-instance synthetic principals — with each one's role assignments and whether it is an admin. Filter by `type` (user/agent) and `search`; paginate with `page`/`limit`.",
      parameters: [
        ...PAGINATION_PARAMS,
        {
          name: "type",
          in: "query",
          required: false,
          description: "Filter by principal kind.",
          schema: { type: "string", enum: ["user", "agent"] },
        },
        {
          name: "search",
          in: "query",
          required: false,
          description: "Case-insensitive substring match on name/id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Principals page",
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
      const page = parsePage(c.req.query("page"));
      const limit = parseLimit(c.req.query("limit"));
      const typeRaw = c.req.query("type");
      const type_ =
        typeRaw === "user" || typeRaw === "agent" ? typeRaw : undefined;
      const search = c.req.query("search");
      const { principals, total } = await listTenantPrincipals(
        db,
        rootTenantId,
        { page, limit, type: type_, search },
      );
      return c.json({
        principals,
        pageInfo: buildPageInfo(page, limit, total),
      });
    },
  );

  router.get(
    "/admin/principals/:principalId",
    describeRoute({
      tags: ["Admin"],
      summary: "A single principal with its roles",
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
          description: "Principal",
          content: {
            "application/json": { schema: resolver(PrincipalDetailResponse) },
          },
        },
        404: {
          description: "Unknown principal",
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
      const principal = await getTenantPrincipal(db, rootTenantId, principalId);
      if (!principal) return c.json({ error: "Unknown principal" }, 404);
      return c.json({ principal });
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

  // ─── Audit (CL-2735/2807) ────────────────────────────────────────

  router.get(
    "/admin/audit",
    describeRoute({
      tags: ["Admin"],
      summary: "Compliance audit log (paginated, filtered)",
      description:
        "Newest-first audit records: who read another principal's timeline, and every admin role change, with resolved actor/target names. Filter by `actor` (id substring), `action`, and a `from`/`to` date range; paginate with `page`/`limit`.",
      parameters: [
        ...PAGINATION_PARAMS,
        {
          name: "actor",
          in: "query",
          required: false,
          description:
            "Case-insensitive substring match on actor principal id.",
          schema: { type: "string" },
        },
        {
          name: "action",
          in: "query",
          required: false,
          description: "Filter by audit action.",
          schema: { type: "string", enum: [...adminAuditActions] },
        },
        {
          name: "from",
          in: "query",
          required: false,
          description: "Inclusive lower bound (ISO date/time) on createdAt.",
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "to",
          in: "query",
          required: false,
          description: "Inclusive upper bound (ISO date/time) on createdAt.",
          schema: { type: "string", format: "date-time" },
        },
      ],
      responses: {
        200: {
          description: "Audit records page",
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
      const page = parsePage(c.req.query("page"));
      const limit = parseLimit(c.req.query("limit"));
      const actor = c.req.query("actor");
      const actionRaw = c.req.query("action");
      const action = (adminAuditActions as readonly string[]).includes(
        actionRaw ?? "",
      )
        ? (actionRaw as AdminAuditAction)
        : undefined;
      const from = parseDateQuery(c.req.query("from"));
      const to = parseDateQuery(c.req.query("to"));
      const { records, total } = await listAuditRecords(db, rootTenantId, {
        page,
        limit,
        actor,
        action,
        from,
        to,
      });
      return c.json({
        records,
        pageInfo: buildPageInfo(page, limit, total),
      });
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
