import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { HubDb } from '../db';
import type { AssetService, RepoStore } from '@intx/hub-sessions';
import { AssetServiceError } from '@intx/hub-sessions';
import { getRequestedUserContext } from '../services/workflow-orchestration';
import {
  SkillLibraryError,
  createSkill,
  updateSkill,
  filesFromZip,
  getSkillAsset,
  getSkillContent,
  listSkills,
  type SkillBundleFileInput,
} from '../services/skill-library';

function errorResponse(c: Context, err: unknown) {
  if (err instanceof SkillLibraryError) {
    const status = err.status as 400 | 404 | 409 | 413;
    return c.json({ error: err.message }, status);
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

  router.get('/skills/:assetId', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);
    const skill = await getSkillAsset(db, context.tenantId, c.req.param('assetId'));
    if (!skill) return c.json({ error: 'Skill not found' }, 404);
    const files = await getSkillContent(repoStore, skill.id, skill.name);
    return c.json({ skill, files });
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
        const existingAssetId = readString(body.assetId);

        if (existingAssetId) {
          if (!text) throw new SkillLibraryError('Skill text is required');
          const skill = await updateSkill(assetService, db, context, {
            assetId: existingAssetId,
            description,
            files: [textFile('SKILL.md', text)],
          });
          return c.json({ skill }, 200);
        }

        if (!name) throw new SkillLibraryError('Skill name is required');
        if (!text) throw new SkillLibraryError('Skill text is required');
        const skill = await createSkill(assetService, db, context, {
          name,
          description,
          files: [textFile('SKILL.md', text)],
        });
        return c.json({ skill }, 201);
      }

      const body = await c.req.parseBody({ all: true });
      const name = readString(body.name)?.trim() ?? '';
      const description = readString(body.description) ?? null;
      const existingAssetId = readString(body.assetId);

      const fileValues = body.files ?? body.file;
      const files = Array.isArray(fileValues) ? fileValues : fileValues ? [fileValues] : [];
      const pathValues = body.paths;
      const paths = Array.isArray(pathValues)
        ? pathValues.map(String)
        : typeof pathValues === 'string'
          ? [pathValues]
          : [];
      const bundleFiles: SkillBundleFileInput[] = [];

      for (const [index, value] of files.entries()) {
        if (!(value instanceof File)) continue;
        const relativePath = paths[index] || value.webkitRelativePath || value.name;
        const content = Buffer.from(await value.arrayBuffer());
        if (files.length === 1 && value.name.toLowerCase().endsWith('.zip')) {
          bundleFiles.push(...(await filesFromZip(content)));
        } else {
          bundleFiles.push({
            path: relativePath,
            content,
            mimeType: value.type || 'application/octet-stream',
          });
        }
      }

      if (existingAssetId) {
        const skill = await updateSkill(assetService, db, context, {
          assetId: existingAssetId,
          description,
          files: bundleFiles,
        });
        return c.json({ skill }, 200);
      }

      if (!name) throw new SkillLibraryError('Skill name is required');
      const skill = await createSkill(assetService, db, context, {
        name,
        description,
        files: bundleFiles,
      });
      return c.json({ skill }, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post('/agents/:agentId/skills/:assetId', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    const agentId = c.req.param('agentId');
    const assetId = c.req.param('assetId');

    const asset = await db.query.asset.findFirst({
      where: and(
        eq(intxSchema.asset.id, assetId),
        eq(intxSchema.asset.tenantId, context.tenantId),
        eq(intxSchema.asset.kind, 'skill')
      ),
    });
    if (!asset) return c.json({ error: 'Skill not found' }, 404);

    try {
      const agentAsset = await assetService.attachAsset({
        agentId,
        assetId,
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

  router.delete('/agents/:agentId/skills/:assetId', async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get('userId'),
      c.req.query('tenantId')
    );
    if (forbidden) return c.json({ error: 'Tenant not accessible' }, 403);
    if (!context) return c.json({ error: 'User context not found' }, 403);

    const agentId = c.req.param('agentId');
    const assetId = c.req.param('assetId');

    const asset = await db.query.asset.findFirst({
      where: and(
        eq(intxSchema.asset.id, assetId),
        eq(intxSchema.asset.tenantId, context.tenantId),
        eq(intxSchema.asset.kind, 'skill')
      ),
    });
    if (!asset) return c.json({ error: 'Skill not found' }, 404);

    // AssetService has no detachAsset method; delete the agentAsset row directly.
    const deleted = await db
      .delete(intxSchema.agentAsset)
      .where(
        and(eq(intxSchema.agentAsset.agentId, agentId), eq(intxSchema.agentAsset.assetId, assetId))
      )
      .returning();
    if (deleted.length === 0) return c.json({ error: 'Skill not attached to this agent' }, 404);
    return c.json({ ok: true });
  });

  return router;
}
