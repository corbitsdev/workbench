import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { getLogger } from "@intx/log";
import type { DB } from "@intx/db";
import type { HubDb } from "../db";
import { workbenchTemplate, workbenchTemplateVersion } from "../db/schema";
import { getUserContext } from "../services/workflow-orchestration";

const log = getLogger("hub:gamma-templates");

const GAMMA_KIND = "gamma";

export type GammaTemplateConfig = {
  gammaId: string;
  systemPrompt: string;
};

export type GammaTemplateRow = {
  id: string;
  version: number;
  name: string;
  gammaId: string;
  systemPrompt: string;
  createdAt: string;
};

function configToRow(
  templateId: string,
  version: number,
  name: string,
  config: Record<string, unknown>,
  createdAt: Date,
): GammaTemplateRow {
  return {
    id: templateId,
    version,
    name,
    gammaId: config["gammaId"] as string,
    systemPrompt: config["systemPrompt"] as string,
    createdAt: createdAt.toISOString(),
  };
}

// Uses DB['db'] (not HubDb) so this function is callable from both the route
// (HubDb is a superset) and the ContextToolEntry (receives DB['db']).
export async function listLatestGammaTemplates(
  db: DB["db"],
  tenantId: string,
): Promise<GammaTemplateRow[]> {
  const rows = await db
    .select({
      id: workbenchTemplate.id,
      version: workbenchTemplateVersion.version,
      name: workbenchTemplateVersion.name,
      config: workbenchTemplateVersion.config,
      createdAt: workbenchTemplateVersion.createdAt,
    })
    .from(workbenchTemplate)
    .innerJoin(
      workbenchTemplateVersion,
      and(
        eq(workbenchTemplateVersion.templateId, workbenchTemplate.id),
        eq(
          workbenchTemplateVersion.version,
          sql<number>`(SELECT MAX(v2.version) FROM template_version v2 WHERE v2.template_id = ${workbenchTemplate.id})`,
        ),
      ),
    )
    .where(
      and(
        eq(workbenchTemplate.tenantId, tenantId),
        eq(workbenchTemplate.kind, GAMMA_KIND),
      ),
    )
    .orderBy(desc(workbenchTemplate.createdAt));

  return rows.map((r) =>
    configToRow(r.id, r.version, r.name, r.config, r.createdAt),
  );
}

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

  router.get("/gamma-templates", async (c) => {
    const userId = c.get("userId");
    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const templates = await listLatestGammaTemplates(db, userContext.tenantId);
    return c.json(templates);
  });

  router.post("/gamma-templates", async (c) => {
    const userId = c.get("userId");
    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const body = await c.req.json<{
      name?: unknown;
      gammaId?: unknown;
      systemPrompt?: unknown;
    }>();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const gammaId = typeof body.gammaId === "string" ? body.gammaId.trim() : "";
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
  });

  router.put("/gamma-templates/:id", async (c) => {
    const userId = c.get("userId");
    const userContext = await getUserContext(db, userId);
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
    const gammaId = typeof body.gammaId === "string" ? body.gammaId.trim() : "";
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
  });

  router.delete("/gamma-templates/:id", async (c) => {
    const userId = c.get("userId");
    const userContext = await getUserContext(db, userId);
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
  });

  return router;
}
