import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';

const log = getLogger(['api', 'members']);

const { principal, user } = intxSchema;

export function createMembersRouter(
  db: DB['db']
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.get('/members', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.query('tenantId');

    if (!tenantId) {
      return c.json({ error: 'tenantId query parameter required' }, 400);
    }

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });

    if (!callerPrincipal) {
      log.warn('Members list forbidden: caller is not a tenant member', { userId, tenantId });
      return c.json({ error: 'Forbidden' }, 403);
    }

    const userPrincipals = await db.query.principal.findMany({
      where: and(eq(principal.tenantId, tenantId), eq(principal.kind, 'user')),
    });

    const refIds = userPrincipals.map((p) => p.refId);
    const users =
      refIds.length > 0
        ? await db.query.user.findMany({
            where: (u, { inArray }) => inArray(u.id, refIds),
          })
        : [];

    const userById = new Map(users.map((u) => [u.id, u]));

    const members = userPrincipals.map((p) => {
      const name = userById.get(p.refId)?.name;
      if (!name) {
        log.warn('User principal has no matching user row — data integrity issue', {
          principalId: p.id,
          refId: p.refId,
          tenantId,
        });
      }
      return { id: p.id, name: name ?? p.id.slice(0, 8) };
    });

    return c.json({ members });
  });

  return router;
}
