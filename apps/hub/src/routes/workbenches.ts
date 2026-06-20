import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { type } from 'arktype';
import { describeRoute, resolver } from 'hono-openapi';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { provisionWorkbenchTenant } from '../lib/tenant-provisioning';
import { requestBodySchema } from '../lib/openapi';

const log = getLogger(['api', 'workbenches']);

type ProductionDB = DB['db'];

// Request/response shapes for the OpenAPI spec. The hub admin CLI consumes
// /openapi.json to discover this operation and validate its payloads; these
// schemas document (they do not replace) the handler's existing manual checks.
const CreateWorkbenchBody = type({ name: 'string' });
const WorkbenchResponse = type({
  id: 'string',
  name: 'string',
  slug: 'string',
  tenantId: 'string',
});
const ErrorResponse = type({ error: 'string' });

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
  router.post(
    '/workbenches',
    describeRoute({
      tags: ['Workbenches'],
      summary: 'Create a workbench sub-tenant',
      description:
        'Creates a named workbench tenant for the authenticated user and provisions them as the owner principal. Idempotent by slug — if the tenant already exists and the user is a principal, returns it with 200; if the tenant exists but the user is not a principal, returns 409.',
      requestBody: {
        content: {
          'application/json': { schema: requestBodySchema(CreateWorkbenchBody) },
        },
      },
      responses: {
        200: {
          description: 'Workbench already existed for this user',
          content: { 'application/json': { schema: resolver(WorkbenchResponse) } },
        },
        201: {
          description: 'Workbench created',
          content: { 'application/json': { schema: resolver(WorkbenchResponse) } },
        },
        400: {
          description: 'Missing name, name too long, or name produced an empty slug',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: 'A workbench with this name already exists',
          content: { 'application/json': { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
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
    }
  );

  return router;
}
