import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import type { DB } from '@intx/db';
import type { HubDb } from '../db';
import { workbenchTemplate, workbenchTemplateVersion } from '../db/schema';
import { getUserContext } from '../lib/user-context';
import { configToRow, listLatestGammaTemplates, GAMMA_KIND } from '../lib/gamma-templates';
import type { GammaTemplateConfig } from '../lib/gamma-templates';

const log = getLogger('hub:gamma-templates');

async function getLatestVersion(db: DB['db'], templateId: string): Promise<number> {
  const [result] = await db
    .select({
      maxVersion: sql<number>`COALESCE(MAX(${workbenchTemplateVersion.version}), 0)`,
    })
    .from(workbenchTemplateVersion)
    .where(eq(workbenchTemplateVersion.templateId, templateId));

  return result?.maxVersion ?? 0;
}

export function createGammaTemplatesRouter(db: HubDb): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.get('/gamma-templates', async (c) => {
    const userId = c.get('userId');
    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const templates = await listLatestGammaTemplates(db, userContext.tenantId);
    return c.json(templates);
  });

  router.post('/gamma-templates', async (c) => {
    const userId = c.get('userId');
    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const body = await c.req.json<{
      name?: unknown;
      gammaId?: unknown;
      systemPrompt?: unknown;
    }>();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const gammaId = typeof body.gammaId === 'string' ? body.gammaId.trim() : '';
    const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';

    if (!name || !gammaId || !systemPrompt) {
      return c.json({ error: 'name, gammaId, and systemPrompt are required' }, 400);
    }

    const config: GammaTemplateConfig = { gammaId, systemPrompt };

    const result = await db.transaction(async (tx) => {
      const [header] = await tx
        .insert(workbenchTemplate)
        .values({ tenantId: userContext.tenantId, kind: GAMMA_KIND })
        .returning();

      if (!header) {
        throw new Error('Failed to insert template');
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
        throw new Error('Failed to insert template version');
      }

      return configToRow(header.id, version.version, version.name, config, version.createdAt);
    });

    log.info('Gamma template created', {
      templateId: result.id,
      tenantId: userContext.tenantId,
    });
    return c.json(result, 201);
  });

  router.put('/gamma-templates/:id', async (c) => {
    const userId = c.get('userId');
    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const templateId = c.req.param('id');

    const [existing] = await db
      .select({ id: workbenchTemplate.id })
      .from(workbenchTemplate)
      .where(
        and(
          eq(workbenchTemplate.id, templateId),
          eq(workbenchTemplate.tenantId, userContext.tenantId),
          eq(workbenchTemplate.kind, GAMMA_KIND)
        )
      )
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Template not found' }, 404);
    }

    const body = await c.req.json<{
      name?: unknown;
      gammaId?: unknown;
      systemPrompt?: unknown;
    }>();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const gammaId = typeof body.gammaId === 'string' ? body.gammaId.trim() : '';
    const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';

    if (!name || !gammaId || !systemPrompt) {
      return c.json({ error: 'name, gammaId, and systemPrompt are required' }, 400);
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
      return c.json({ error: 'Failed to update template' }, 500);
    }

    log.info('Gamma template updated', { templateId, version: nextVersion });
    return c.json(
      configToRow(templateId, newVersion.version, newVersion.name, config, newVersion.createdAt)
    );
  });

  router.delete('/gamma-templates/:id', async (c) => {
    const userId = c.get('userId');
    const userContext = await getUserContext(db, userId);
    if (!userContext) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const templateId = c.req.param('id');
    const deleted = await db
      .delete(workbenchTemplate)
      .where(
        and(
          eq(workbenchTemplate.id, templateId),
          eq(workbenchTemplate.tenantId, userContext.tenantId),
          eq(workbenchTemplate.kind, GAMMA_KIND)
        )
      )
      .returning({ id: workbenchTemplate.id });

    if (deleted.length === 0) {
      return c.json({ error: 'Template not found' }, 404);
    }

    log.info('Gamma template deleted', { templateId });
    return c.json({ ok: true });
  });

  return router;
}
