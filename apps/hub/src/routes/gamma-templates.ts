import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { type } from "arktype";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import type { DB } from "@intx/db";
import { createGrantStore, schema as intxSchema } from "@intx/db";
import { authorize, matchPattern } from "@intx/authz";
import type { GrantStore } from "@intx/authz";
import { generateId } from "@intx/hub-common";
import {
  GammaTemplateSchema,
  GammaTemplateBodySchema,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { workbenchTemplate, workbenchTemplateVersion } from "../db/schema";
import { getRequestedUserContext } from "../lib/user-context";
import {
  configToRow,
  listInheritedGammaTemplates,
  GAMMA_KIND,
} from "../lib/gamma-templates";
import type {
  GammaTemplateConfig,
  GammaTemplateRow,
} from "../lib/gamma-templates";
import { requestBodySchema } from "../lib/openapi";

const { grant, principal } = intxSchema;

const log = getLogger("hub:gamma-templates");

// Canonical wire shape shared with the web hook (see @workbench/shared). Used
// both as the hub's list-response schema and, without `canManage`, for the
// single-item create/update responses documented in the OpenAPI spec.
export type GammaTemplateListItem = typeof GammaTemplateSchema.infer;
const GammaTemplateList = GammaTemplateSchema.array();
const GammaTemplate = GammaTemplateSchema;

const GammaTemplateBody = GammaTemplateBodySchema;
const DelegateBody = type({ principalId: "string" });
const OkResponse = type({ ok: "boolean" });
const DeleteResponse = OkResponse;
const ErrorResponse = type({ error: "string" });

const TEMPLATE_MANAGE_ACTION = "manage";

// Parses a create/update body through the shared arktype schema, then trims and
// rejects blanks. Returns either the cleaned fields or a 400 error message.
async function parseTemplateBody(
  c: Context,
): Promise<
  { name: string; gammaId: string; description: string } | { error: string }
> {
  const raw = await c.req.json().catch(() => null);
  const parsed = GammaTemplateBody(raw);
  if (parsed instanceof type.errors) {
    return { error: parsed.summary };
  }
  const name = parsed.name.trim();
  const gammaId = parsed.gammaId.trim();
  const description = parsed.description.trim();
  if (!name || !gammaId || !description) {
    return { error: "name, gammaId, and description are required" };
  }
  return { name, gammaId, description };
}

function templateResource(templateId: string): string {
  return `template:${templateId}`;
}

// `manage` grant a row's creator/delegate gets. Reaped only for *agent*
// principals on relaunch (agent-provisioning deletes creator/invoker grants
// keyed by the instance's synthetic principal); a user principal's template
// grant is never touched, so "creator" is the correct, durable origin.
//
// NOTE: delegate grants (POST /:id/delegates) reuse origin "creator" because
// the grant-origin enum is ["system","role","creator","invoker"] and has no
// "delegate" value. Consequence: audit/reap logic cannot distinguish an
// originally-created grant from a delegated one by origin alone — a future
// "delegate" origin (or a `conditions` marker) would be needed to tell them
// apart. No caller currently depends on that distinction.
function buildTemplateManageGrant(
  templateId: string,
  tenantId: string,
  principalId: string,
  now: Date,
): typeof grant.$inferInsert {
  return {
    id: generateId("grant"),
    tenantId,
    principalId,
    resource: templateResource(templateId),
    action: TEMPLATE_MANAGE_ACTION,
    effect: "allow",
    origin: "creator",
    conditions: null,
    createdAt: now,
    updatedAt: now,
  };
}

function canManageRow(
  grants: Awaited<ReturnType<GrantStore["collectGrants"]>>,
  templateId: string,
): boolean {
  const resource = templateResource(templateId);
  for (const g of grants) {
    if (g.effect !== "allow") continue;
    if (!matchPattern(g.resource, resource)) continue;
    if (!matchPattern(g.action, TEMPLATE_MANAGE_ACTION)) continue;
    return true;
  }
  return false;
}

type Queryable = Pick<DB["db"], "select">;

async function getLatestVersion(
  db: Queryable,
  templateId: string,
): Promise<number> {
  const [result] = await db
    .select({
      maxVersion: sql<number>`COALESCE(MAX(${workbenchTemplateVersion.version}), 0)`,
    })
    .from(workbenchTemplateVersion)
    .where(eq(workbenchTemplateVersion.templateId, templateId));

  return result?.maxVersion ?? 0;
}

export function createGammaTemplatesRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();
  const grantStore = createGrantStore(db);

  router.get(
    "/gamma-templates",
    describeRoute({
      tags: ["Gamma Templates"],
      summary: "List Gamma templates",
      description:
        "Lists Gamma templates visible to the active workbench: its own plus those inherited from ancestor tenants up to the global tenant. Optional `?tenantId` selects a workbench the caller belongs to.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Templates visible to the workbench",
          content: {
            "application/json": { schema: resolver(GammaTemplateList) },
          },
        },
        403: {
          description: "Caller is not a member of the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Tenant not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!userContext) {
        return c.json({ error: "Tenant not found" }, 404);
      }

      // Reads walk the ancestor chain so a workbench sees its own templates plus
      // those inherited from the global tenant.
      const templates = await listInheritedGammaTemplates(
        db,
        userContext.tenantId,
      );

      // One grant collection for the caller; mark each row's manage permission
      // in memory rather than calling authorize() per row.
      const grants = await grantStore.collectGrants(
        userContext.principalId,
        userContext.tenantId,
      );
      const items: GammaTemplateListItem[] = templates.map(
        (t: GammaTemplateRow) => ({
          ...t,
          canManage: canManageRow(grants, t.id),
        }),
      );
      return c.json(items);
    },
  );

  // Writes land in the active workbench (`userContext.tenantId`); reads above
  // walk ancestors.
  router.post(
    "/gamma-templates",
    describeRoute({
      tags: ["Gamma Templates"],
      summary: "Create a Gamma template",
      description:
        "Creates a Gamma template (version 1) in the active workbench and grants the creator `manage` on it. Optional `?tenantId` selects a workbench the caller belongs to. `name`, `gammaId`, and `description` are required.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        content: {
          "application/json": { schema: requestBodySchema(GammaTemplateBody) },
        },
      },
      responses: {
        201: {
          description: "Template created",
          content: { "application/json": { schema: resolver(GammaTemplate) } },
        },
        400: {
          description: "Missing name, gammaId, or description",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not a member of the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Tenant not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!userContext) {
        return c.json({ error: "Tenant not found" }, 404);
      }

      const parsed = await parseTemplateBody(c);
      if ("error" in parsed) {
        return c.json({ error: parsed.error }, 400);
      }
      const { name, gammaId, description } = parsed;

      const config: GammaTemplateConfig = { gammaId, description };

      const result = await db.transaction(async (tx) => {
        const [header] = await tx
          .insert(workbenchTemplate)
          .values({ tenantId: userContext.tenantId, kind: GAMMA_KIND })
          .returning();

        if (!header) {
          throw new Error("Failed to insert template");
        }

        const [version] = await tx
          .insert(workbenchTemplateVersion)
          .values({
            templateId: header.id,
            version: 1,
            name,
            config,
            authorId: userContext.principalId,
          })
          .returning();

        if (!version) {
          throw new Error("Failed to insert template version");
        }

        await tx
          .insert(grant)
          .values(
            buildTemplateManageGrant(
              header.id,
              userContext.tenantId,
              userContext.principalId,
              new Date(),
            ),
          );

        return configToRow(
          header.id,
          version.version,
          version.name,
          config,
          version.authorId,
          version.createdAt,
        );
      });

      log.info("Gamma template created", {
        templateId: result.id,
        tenantId: userContext.tenantId,
      });
      // The creator holds the manage grant just written, so canManage is true.
      return c.json({ ...result, canManage: true }, 201);
    },
  );

  router.put(
    "/gamma-templates/:id",
    describeRoute({
      tags: ["Gamma Templates"],
      summary: "Update a Gamma template",
      description:
        "Creates a new version of an existing Gamma template in the active workbench. Requires `manage` on the template. Optional `?tenantId` selects a workbench the caller belongs to. `name`, `gammaId`, and `description` are required.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        content: {
          "application/json": { schema: requestBodySchema(GammaTemplateBody) },
        },
      },
      responses: {
        200: {
          description: "Template updated; returns the new version",
          content: { "application/json": { schema: resolver(GammaTemplate) } },
        },
        400: {
          description: "Missing name, gammaId, or description",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description:
            "Caller is not a member of the tenant or lacks manage on the template",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Tenant or template not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Failed to insert the new version",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!userContext) {
        return c.json({ error: "Tenant not found" }, 404);
      }

      const templateId = c.req.param("id");

      const [existing] = await db
        .select({ id: workbenchTemplate.id })
        .from(workbenchTemplate)
        .where(
          and(
            eq(workbenchTemplate.id, templateId),
            eq(workbenchTemplate.tenantId, userContext.tenantId),
            eq(workbenchTemplate.kind, GAMMA_KIND),
          ),
        )
        .limit(1);

      if (!existing) {
        return c.json({ error: "Template not found" }, 404);
      }

      // Tenant-scoping assumption: getUserContext/getRequestedUserContext always
      // resolve principalId and tenantId together (co-tenanted), so this manage
      // check, the template existence check above, and any grant we later plant
      // all share one tenant scope. collectGrants filters by that same tenantId,
      // so the authz gate never mixes grants across tenants.
      const manage = await authorize(
        grantStore,
        userContext.principalId,
        userContext.tenantId,
        templateResource(templateId),
        TEMPLATE_MANAGE_ACTION,
      );
      if (manage.effect !== "allow") {
        return c.json(
          { error: "You do not have permission to manage this template" },
          403,
        );
      }

      const parsed = await parseTemplateBody(c);
      if ("error" in parsed) {
        return c.json({ error: parsed.error }, 400);
      }
      const { name, gammaId, description } = parsed;

      const config: GammaTemplateConfig = { gammaId, description };

      // Read-then-insert of the next version must be atomic: two concurrent
      // PUTs both reading MAX(version)=N would otherwise both insert N+1 and
      // collide (or silently overwrite). The transaction serializes the pair.
      const newVersion = await db.transaction(async (tx) => {
        const currentVersion = await getLatestVersion(tx, templateId);
        const [row] = await tx
          .insert(workbenchTemplateVersion)
          .values({
            templateId,
            version: currentVersion + 1,
            name,
            config,
            authorId: userContext.principalId,
          })
          .returning();
        return row;
      });

      if (!newVersion) {
        return c.json({ error: "Failed to update template" }, 500);
      }

      log.info("Gamma template updated", {
        templateId,
        version: newVersion.version,
      });
      // The caller passed the manage authorization gate above, so canManage is true.
      return c.json({
        ...configToRow(
          templateId,
          newVersion.version,
          newVersion.name,
          config,
          newVersion.authorId,
          newVersion.createdAt,
        ),
        canManage: true,
      });
    },
  );

  router.delete(
    "/gamma-templates/:id",
    describeRoute({
      tags: ["Gamma Templates"],
      summary: "Delete a Gamma template",
      description:
        "Deletes a Gamma template (and its versions) from the active workbench. Requires `manage` on the template. Optional `?tenantId` selects a workbench the caller belongs to.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Template deleted",
          content: { "application/json": { schema: resolver(DeleteResponse) } },
        },
        403: {
          description:
            "Caller is not a member of the tenant or lacks manage on the template",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Tenant or template not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!userContext) {
        return c.json({ error: "Tenant not found" }, 404);
      }

      const templateId = c.req.param("id");

      const [existing] = await db
        .select({ id: workbenchTemplate.id })
        .from(workbenchTemplate)
        .where(
          and(
            eq(workbenchTemplate.id, templateId),
            eq(workbenchTemplate.tenantId, userContext.tenantId),
            eq(workbenchTemplate.kind, GAMMA_KIND),
          ),
        )
        .limit(1);

      if (!existing) {
        return c.json({ error: "Template not found" }, 404);
      }

      const manage = await authorize(
        grantStore,
        userContext.principalId,
        userContext.tenantId,
        templateResource(templateId),
        TEMPLATE_MANAGE_ACTION,
      );
      if (manage.effect !== "allow") {
        return c.json(
          { error: "You do not have permission to manage this template" },
          403,
        );
      }

      const deleted = await db
        .delete(workbenchTemplate)
        .where(
          and(
            eq(workbenchTemplate.id, templateId),
            eq(workbenchTemplate.tenantId, userContext.tenantId),
            eq(workbenchTemplate.kind, GAMMA_KIND),
          ),
        )
        .returning({ id: workbenchTemplate.id });

      if (deleted.length === 0) {
        return c.json({ error: "Template not found" }, 404);
      }

      log.info("Gamma template deleted", { templateId });
      return c.json({ ok: true });
    },
  );

  router.post(
    "/gamma-templates/:id/delegates",
    describeRoute({
      tags: ["Gamma Templates"],
      summary: "Delegate manage on a Gamma template",
      description:
        "Grants `manage` on a Gamma template to another principal. Requires `manage` on the template. Optional `?tenantId` selects a workbench the caller belongs to.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        content: {
          "application/json": { schema: requestBodySchema(DelegateBody) },
        },
      },
      responses: {
        201: {
          description: "Manage grant created for the target principal",
          content: { "application/json": { schema: resolver(OkResponse) } },
        },
        400: {
          description: "Missing principalId",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description:
            "Caller is not a member of the tenant or lacks manage on the template",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Tenant or template not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!userContext) {
        return c.json({ error: "Tenant not found" }, 404);
      }

      const templateId = c.req.param("id");

      const [existing] = await db
        .select({ id: workbenchTemplate.id })
        .from(workbenchTemplate)
        .where(
          and(
            eq(workbenchTemplate.id, templateId),
            eq(workbenchTemplate.tenantId, userContext.tenantId),
            eq(workbenchTemplate.kind, GAMMA_KIND),
          ),
        )
        .limit(1);

      if (!existing) {
        return c.json({ error: "Template not found" }, 404);
      }

      const manage = await authorize(
        grantStore,
        userContext.principalId,
        userContext.tenantId,
        templateResource(templateId),
        TEMPLATE_MANAGE_ACTION,
      );
      if (manage.effect !== "allow") {
        return c.json(
          { error: "You do not have permission to manage this template" },
          403,
        );
      }

      const rawBody = await c.req.json().catch(() => null);
      const parsedBody = DelegateBody(rawBody);
      if (parsedBody instanceof type.errors) {
        return c.json({ error: "principalId is required" }, 400);
      }
      const principalId = parsedBody.principalId.trim();

      if (!principalId) {
        return c.json({ error: "principalId is required" }, 400);
      }

      // The target must be a principal of THIS tenant. getRequestedUserContext
      // co-tenants principalId with tenantId (see the tenant-scoping note at the
      // manage gate), so a grant we plant here is only ever collected for a
      // caller resolved in the same tenant. Guarding against a stray/cross-tenant
      // principalId prevents planting an orphan or cross-tenant manage grant.
      const targetPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(principal.id, principalId),
          eq(principal.tenantId, userContext.tenantId),
        ),
      });
      if (!targetPrincipal) {
        return c.json(
          { error: "principalId is not a member of this tenant" },
          400,
        );
      }

      // Idempotent: if this principal already holds an equivalent allow/manage
      // grant on this template, do not add a duplicate row.
      const resource = templateResource(templateId);
      const existingGrant = await db.query.grant.findFirst({
        where: and(
          eq(grant.tenantId, userContext.tenantId),
          eq(grant.principalId, principalId),
          eq(grant.resource, resource),
          eq(grant.action, TEMPLATE_MANAGE_ACTION),
          eq(grant.effect, "allow"),
        ),
      });
      if (existingGrant) {
        return c.json({ ok: true }, 201);
      }

      await db
        .insert(grant)
        .values(
          buildTemplateManageGrant(
            templateId,
            userContext.tenantId,
            principalId,
            new Date(),
          ),
        );

      log.info("Gamma template delegated", {
        templateId,
        principalId,
        tenantId: userContext.tenantId,
      });
      return c.json({ ok: true }, 201);
    },
  );

  return router;
}
