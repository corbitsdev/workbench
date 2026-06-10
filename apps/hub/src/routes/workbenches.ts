import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { provisionWorkbenchTenant } from '../lib/tenant-provisioning';
import { workflowRegistry } from '@workbench/workflow-core';

const log = getLogger(['api', 'workbenches']);

type ProductionDB = DB['db'];

/**
 * Derive a URL-safe slug from a workbench name.
 * Lowercases, replaces non-alphanumeric sequences with hyphens, trims leading/
 * trailing hyphens, and truncates to 63 characters.
 */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function createWorkbenchesRouter(db: ProductionDB): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  /**
   * POST /workbenches
   *
   * Creates a named workbench tenant for the authenticated user and provisions
   * them as the owner principal. Idempotent by slug — if the tenant already
   * exists and the user is a principal, returns it with 200. If the tenant
   * exists but the user is not a principal, returns 409.
   */
  router.post('/workbenches', async (c) => {
    const userId = c.get('userId');

    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';

    if (!rawName) {
      log.warn('Workbench creation failed: missing name', { userId });
      return c.json({ error: 'name is required' }, 400);
    }

    if (rawName.length > 100) {
      log.warn('Workbench creation failed: name too long', { userId, length: rawName.length });
      return c.json({ error: 'name must be 100 characters or fewer' }, 400);
    }

    const slug = toSlug(rawName);

    if (!slug) {
      log.warn('Workbench creation failed: name produced empty slug', { userId, name: rawName });
      return c.json({ error: 'name must contain at least one alphanumeric character' }, 400);
    }

    let provisioned: { tenantId: string; principalId: string; alreadyExists: boolean };
    try {
      provisioned = await provisionWorkbenchTenant(db, {
        userId,
        name: rawName,
        slug,
        workflowKinds: workflowRegistry.list().map((w) => w.kind),
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException & { code?: string }).code === 'SLUG_CONFLICT'
      ) {
        log.warn('Workbench slug conflict', { userId, slug });
        return c.json({ error: 'A workbench with this name already exists' }, 409);
      }
      throw err;
    }

    if (provisioned.alreadyExists) {
      log.info('Workbench already exists for user', { userId, tenantId: provisioned.tenantId });
      // Re-fetch tenant name/slug for the response.
      const existingTenant = await db.query.tenant.findFirst({
        where: eq(intxSchema.tenant.id, provisioned.tenantId),
      });

      return c.json({
        id: provisioned.principalId,
        name: existingTenant?.name ?? rawName,
        slug: existingTenant?.slug ?? slug,
        tenantId: provisioned.tenantId,
      });
    }

    return c.json(
      {
        id: provisioned.principalId,
        name: rawName,
        slug,
        tenantId: provisioned.tenantId,
      },
      201
    );
  });

  return router;
}
