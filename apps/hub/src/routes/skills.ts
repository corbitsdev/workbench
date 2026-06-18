import { Hono, type Context } from 'hono';
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { HubDb } from '../db';
import { schema } from '../db';
import type { AssetService, RepoStore } from '@intx/hub-sessions';
import { AssetServiceError } from '@intx/hub-sessions';
import { getRequestedUserContext } from '../services/workflow-orchestration';
import {
  SkillLibraryError,
  createSkillVersionFromBundle,
  filesFromZip,
  getSkillDetail,
  getSkillVersionPreview,
  listSkills,
  type SkillBundleFileInput,
} from '../services/skill-library';

function errorResponse(c: Context, err: unknown) {
  if (err instanceof SkillLibraryError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  throw err;
}

function textFile(name: string, content: string): SkillBundleFileInput {
  return { path: name, content: Buffer.from(content), mimeType: 'text/markdown' };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function createSkillsRouter(
  db: HubDb,
  assetService: AssetService,
  repoStore: RepoStore
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.get('/skills', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);
    return c.json({ skills: await listSkills(db, context.tenantId) });
  });

  router.get('/skills/:id', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);
    const detail = await getSkillDetail(db, context.tenantId, c.req.param('id'));
    if (!detail) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ skill: detail });
  });

  router.get('/skill-versions/:id/preview', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);
    const preview = await getSkillVersionPreview(
      db,
      repoStore,
      context.tenantId,
      c.req.param('id')
    );
    if (!preview) return c.json({ error: 'Skill version not found' }, 404);
    return c.json(preview);
  });

  router.post('/skills', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    try {
      const contentType = c.req.header('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const body = (await c.req.json()) as Record<string, unknown>;
        const name = readString(body.name)?.trim() ?? '';
        const description = readString(body.description) ?? null;
        const text = readString(body.text)?.trim() ?? '';
        const existingSkillId = readString(body.skillId);
        if (!name) throw new SkillLibraryError('Skill name is required');
        if (!text) throw new SkillLibraryError('Skill text is required');
        const skill = await createSkillVersionFromBundle(db, context, assetService, {
          name,
          description,
          files: [textFile('SKILL.md', text)],
          ...(existingSkillId ? { existingSkillId } : {}),
        });
        return c.json({ skill }, 201);
      }

      const body = await c.req.parseBody({ all: true });
      const name = readString(body.name)?.trim() ?? '';
      const description = readString(body.description) ?? null;
      const existingSkillId = readString(body.skillId);
      if (!name) throw new SkillLibraryError('Skill name is required');

      const fileValues = body.files ?? body.file;
      const files = Array.isArray(fileValues) ? fileValues : fileValues ? [fileValues] : [];
      const pathValues = body.paths;
      const paths = Array.isArray(pathValues)
        ? pathValues.map(String)
        : typeof pathValues === 'string'
          ? [pathValues]
          : [];
      const bundleFiles: SkillBundleFileInput[] = [];
      let source: 'file' | 'folder' | 'zip' = 'file';

      for (const [index, value] of files.entries()) {
        if (!(value instanceof File)) continue;
        const relativePath = paths[index] || value.webkitRelativePath || value.name;
        const content = Buffer.from(await value.arrayBuffer());
        if (files.length === 1 && value.name.toLowerCase().endsWith('.zip')) {
          source = 'zip';
          bundleFiles.push(...(await filesFromZip(content)));
        } else {
          if (relativePath.includes('/')) source = 'folder';
          bundleFiles.push({
            path: relativePath,
            content,
            mimeType: value.type || 'application/octet-stream',
          });
        }
      }

      const skill = await createSkillVersionFromBundle(db, context, assetService, {
        name,
        description,
        source,
        files: bundleFiles,
        ...(existingSkillId ? { existingSkillId } : {}),
      });
      return c.json({ skill }, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post('/agents/:agentId/skills/:skillId', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    const agentId = c.req.param('agentId');
    const skillId = c.req.param('skillId');

    const latestVersion = await db.query.skillVersion.findFirst({
      where: eq(schema.skillVersion.skillId, skillId),
      orderBy: [desc(schema.skillVersion.version)],
    });
    if (!latestVersion) return c.json({ error: 'Skill not found' }, 404);

    try {
      const agentAsset = await assetService.attachAsset({
        agentId,
        assetId: latestVersion.assetId,
        ref: 'refs/heads/main',
      });
      return c.json({ agentAsset }, 201);
    } catch (err) {
      if (err instanceof AssetServiceError && err.reason === 'duplicate_attachment') {
        return c.json({ error: 'Skill already attached to this agent' }, 409);
      }
      throw err;
    }
  });

  router.delete('/agents/:agentId/skills/:skillId', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    const agentId = c.req.param('agentId');
    const skillId = c.req.param('skillId');

    const versions = await db.query.skillVersion.findMany({
      where: eq(schema.skillVersion.skillId, skillId),
    });
    if (versions.length === 0) return c.json({ error: 'Skill not found' }, 404);

    const assetIds = versions.map((v) => v.assetId);
    const deleted = await db
      .delete(schema.agentAsset)
      .where(and(eq(schema.agentAsset.agentId, agentId), inArray(schema.agentAsset.assetId, assetIds)))
      .returning();
    if (deleted.length === 0) return c.json({ error: 'Skill not attached to this agent' }, 404);
    return c.json({ ok: true });
  });

  return router;
}
