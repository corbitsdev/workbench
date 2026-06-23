import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { type } from 'arktype';

import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';

import { getAnalyticsSummary } from './queries';

const SummaryQuery = type({
  'startDate?': /^\d{4}-\d{2}-\d{2}$/,
  'endDate?': /^\d{4}-\d{2}-\d{2}$/,
  'agentId?': 'string',
  'instanceId?': 'string',
});

const log = getLogger(['hub', 'analytics', 'routes']);

export type CreateAnalyticsRoutesDeps = {
  db: DB['db'];
  requireRead: MiddlewareHandler;
};

export function createAnalyticsRoutes({ db, requireRead }: CreateAnalyticsRoutesDeps): Hono {
  const app = new Hono();

  const summaryHandler = async (c: Context) => {
    const tenantId = c.req.param('tenantId');
    if (!tenantId)
      return c.json({ error: { code: 'bad_request', message: 'Missing tenantId' } }, 400);

    const query = SummaryQuery({
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
      agentId: c.req.query('agentId'),
      instanceId: c.req.query('instanceId'),
    });
    if (query instanceof type.errors) {
      return c.json({ error: { code: 'bad_request', message: query.summary } }, 400);
    }

    try {
      const range =
        query.startDate !== undefined || query.endDate !== undefined
          ? {
              ...(query.startDate !== undefined ? { startDate: query.startDate } : {}),
              ...(query.endDate !== undefined ? { endDate: query.endDate } : {}),
            }
          : undefined;
      return c.json(
        await getAnalyticsSummary({
          db,
          tenantId,
          ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
          ...(query.instanceId !== undefined ? { instanceId: query.instanceId } : {}),
          ...(range !== undefined ? { range } : {}),
        })
      );
    } catch (error) {
      log.error('Analytics summary query failed for tenant {tenantId}: {error}', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: { code: 'internal_error', message: 'Failed to query analytics' } },
        500
      );
    }
  };

  app.get('/summary', requireRead, summaryHandler);

  return app;
}
