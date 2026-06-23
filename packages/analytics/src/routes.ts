import { type Context, Hono, type MiddlewareHandler } from 'hono';

import type { DB } from '@intx/db';

import { getAnalyticsSummary } from './queries';

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
    const startDate = optionalDate(c.req.query('startDate'));
    const endDate = optionalDate(c.req.query('endDate'));
    if (startDate === null || endDate === null) {
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: 'startDate and endDate must use YYYY-MM-DD format',
          },
        },
        400
      );
    }

    try {
      return c.json(
        await getAnalyticsSummary({
          db,
          tenantId,
          range: {
            ...(startDate === undefined ? {} : { startDate }),
            ...(endDate === undefined ? {} : { endDate }),
          },
        })
      );
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

function optionalDate(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}
