import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { type } from 'arktype';

import type { DB } from '@intx/db';

import { getAnalyticsSummary } from './queries';

const DateRangeQuery = type({
  'startDate?': /^\d{4}-\d{2}-\d{2}$/,
  'endDate?': /^\d{4}-\d{2}-\d{2}$/,
});

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

    const range = DateRangeQuery({
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
    });
    if (range instanceof type.errors) {
      return c.json(
        { error: { code: 'bad_request', message: range.summary } },
        400
      );
    }

    try {
      return c.json(await getAnalyticsSummary({ db, tenantId, range }));
    } catch {
      return c.json(
        { error: { code: 'internal_error', message: 'Failed to query analytics' } },
        500
      );
    }
  };

  app.get('/summary', requireRead, summaryHandler);

  return app;
}
