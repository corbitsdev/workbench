import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { type } from "arktype";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import type { DB } from "@intx/db";
import type { HubDb } from "../db";
import { workbenchTemplate, workbenchTemplateVersion } from "../db/schema";
import { getRequestedUserContext } from "../lib/user-context";
import {
  configToRow,
  listInheritedGammaTemplates,
  GAMMA_KIND,
} from "../lib/gamma-templates";
import type { GammaTemplateConfig } from "../lib/gamma-templates";
import { requestBodySchema } from "../lib/openapi";

const log = getLogger("hub:gamma-templates");

// Response/body shapes for the OpenAPI spec. The hub admin CLI consumes
// /openapi.json to discover these operations; these schemas document (they do
// not replace) the handlers' existing manual validation.
const GammaTemplate = type({
  id: "string",
  version: "number",
  name: "string",
  gammaId: "string",
  systemPrompt: "string",
  createdAt: "string",
});
const GammaTemplateList = GammaTemplate.array();
const GammaTemplateBody = type({
  name: "string",
  gammaId: "string",
  systemPrompt: "string",
});
const DeleteResponse = type({ ok: "boolean" });
const ErrorResponse = type({ error: "string" });

async function getLatestVersion(
  db: DB["db"],
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
      return c.json(templates);
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
        "Creates a Gamma template (version 1) in the active workbench. Optional `?tenantId` selects a workbench the caller belongs to. `name`, `gammaId`, and `systemPrompt` are required.",
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
          description: "Missing name, gammaId, or systemPrompt",
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

      const body = await c.req.json<{
        name?: unknown;
        gammaId?: unknown;
        systemPrompt?: unknown;
      }>();
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const gammaId =
        typeof body.gammaId === "string" ? body.gammaId.trim() : "";
      const systemPrompt =
        typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";

      if (!name || !gammaId || !systemPrompt) {
        return c.json(
          { error: "name, gammaId, and systemPrompt are required" },
          400,
        );
      }

      const config: GammaTemplateConfig = { gammaId, systemPrompt };

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

        return configToRow(
          header.id,
          version.version,
          version.name,
          config,
          version.createdAt,
        );
      });

      log.info("Gamma template created", {
        templateId: result.id,
        tenantId: userContext.tenantId,
      });
      return c.json(result, 201);
    },
  );

  router.put(
    "/gamma-templates/:id",
    describeRoute({
      tags: ["Gamma Templates"],
      summary: "Update a Gamma template",
      description:
        "Creates a new version of an existing Gamma template in the active workbench. Optional `?tenantId` selects a workbench the caller belongs to. `name`, `gammaId`, and `systemPrompt` are required.",
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
          description: "Missing name, gammaId, or systemPrompt",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not a member of the requested tenant",
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

      const body = await c.req.json<{
        name?: unknown;
        gammaId?: unknown;
        systemPrompt?: unknown;
      }>();
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const gammaId =
        typeof body.gammaId === "string" ? body.gammaId.trim() : "";
      const systemPrompt =
        typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";

      if (!name || !gammaId || !systemPrompt) {
        return c.json(
          { error: "name, gammaId, and systemPrompt are required" },
          400,
        );
      }

      const config: GammaTemplateConfig = { gammaId, systemPrompt };
      const currentVersion = await getLatestVersion(db, templateId);
      const nextVersion = currentVersion + 1;

      const [newVersion] = await db
        .insert(workbenchTemplateVersion)
        .values({
          templateId,
          version: nextVersion,
          name,
          config,
          authorId: userContext.principalId,
        })
        .returning();

      if (!newVersion) {
        return c.json({ error: "Failed to update template" }, 500);
      }

      log.info("Gamma template updated", { templateId, version: nextVersion });
      return c.json(
        configToRow(
          templateId,
          newVersion.version,
          newVersion.name,
          config,
          newVersion.createdAt,
        ),
      );
    },
  );

  router.delete(
    "/gamma-templates/:id",
    describeRoute({
      tags: ["Gamma Templates"],
      summary: "Delete a Gamma template",
      description:
        "Deletes a Gamma template (and its versions) from the active workbench. Optional `?tenantId` selects a workbench the caller belongs to.",
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
          description: "Caller is not a member of the requested tenant",
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

  return router;
}
