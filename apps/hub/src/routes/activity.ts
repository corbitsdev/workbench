import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { type } from 'arktype';
import { Hono, type Env } from 'hono';

import { getActivityOverview } from '../services/activity-overview';

const log = getLogger(['hub', 'activity']);

type ActivityRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
    db: DB['db'];
  };
};

const OverviewQuery = type({
  'startDate?': 'string',
  'endDate?': 'string',
});

export type CreateActivityRouterDeps = {
  db: DB['db'];
};

export function createActivityRouter({ db }: CreateActivityRouterDeps): Hono<ActivityRouteEnv> {
  const app = new Hono<ActivityRouteEnv>();

  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  app.get('/overview', async (c) => {
    const tenant = c.get('tenant');
    const query = OverviewQuery({
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
    });
    if (query instanceof type.errors) {
      return c.json({ error: { code: 'bad_request', message: query.summary } }, 400);
    }

    const range =
      query.startDate !== undefined || query.endDate !== undefined
        ? {
            ...(query.startDate !== undefined ? { startDate: query.startDate } : {}),
            ...(query.endDate !== undefined ? { endDate: query.endDate } : {}),
          }
        : undefined;

    try {
      const overview = await getActivityOverview({
        db: c.get('db'),
        tenantId: tenant.id,
        ...(range !== undefined ? { range } : {}),
      });
      return c.json(overview);
    } catch (error) {
      log.error('Activity overview failed for tenant {tenantId}: {error}', {
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: { code: 'internal_error', message: 'Failed to load activity overview' } },
        500
      );
    }
  });

  return app;
}
