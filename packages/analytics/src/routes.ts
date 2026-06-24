import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { type } from 'arktype';

import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import type { Env } from 'hono';

/** Matches @intx/hub-api TenantEnv variables used by analytics routes. */
export type AnalyticsRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

import { getAnalyticsSummary, getAnalyticsSummaryByAgent } from './queries';

function optionalQuery(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  return value === undefined || value === '' ? undefined : value;
}

const SummaryQuery = type({
  'startDate?': /^\d{4}-\d{2}-\d{2}$/,
  'endDate?': /^\d{4}-\d{2}-\d{2}$/,
  'agentId?': 'string',
  'instanceId?': 'string',
});

const log = getLogger(['hub', 'analytics', 'routes']);

export type CreateAnalyticsRoutesDeps = {
  db: DB['db'];
  /** Optional extra gate after Interchange `resolveTenant` (active tenant membership). */
  requireRead?: MiddlewareHandler;
};

export function createAnalyticsRoutes({
  db,
  requireRead,
}: CreateAnalyticsRoutesDeps): Hono<AnalyticsRouteEnv> {
  const app = new Hono<AnalyticsRouteEnv>();
  const readGate: MiddlewareHandler =
    requireRead ??
    (async (_c, next) => {
      await next();
    });

  const summaryHandler = async (c: Context<AnalyticsRouteEnv>) => {
    const tenantId = c.req.param('tenantId') ?? c.get('tenant').id;
    if (!tenantId) {
      return c.json({ error: { code: 'bad_request', message: 'Missing tenantId' } }, 400);
    }

    const queryInput: {
      startDate?: string;
      endDate?: string;
      agentId?: string;
      instanceId?: string;
    } = {};
    const startDate = optionalQuery(c, 'startDate');
    const endDate = optionalQuery(c, 'endDate');
    const agentId = optionalQuery(c, 'agentId');
    const instanceId = optionalQuery(c, 'instanceId');
    if (startDate !== undefined) queryInput.startDate = startDate;
    if (endDate !== undefined) queryInput.endDate = endDate;
    if (agentId !== undefined) queryInput.agentId = agentId;
    if (instanceId !== undefined) queryInput.instanceId = instanceId;

    const query = SummaryQuery(queryInput);
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

  const byAgentHandler = async (c: Context<AnalyticsRouteEnv>) => {
    const tenantId = c.req.param('tenantId') ?? c.get('tenant').id;
    if (!tenantId) {
      return c.json({ error: { code: 'bad_request', message: 'Missing tenantId' } }, 400);
    }

    const queryInput: {
      startDate?: string;
      endDate?: string;
      agentId?: string;
      instanceId?: string;
    } = {};
    const startDate = optionalQuery(c, 'startDate');
    const endDate = optionalQuery(c, 'endDate');
    const agentId = optionalQuery(c, 'agentId');
    const instanceId = optionalQuery(c, 'instanceId');
    if (startDate !== undefined) queryInput.startDate = startDate;
    if (endDate !== undefined) queryInput.endDate = endDate;
    if (agentId !== undefined) queryInput.agentId = agentId;
    if (instanceId !== undefined) queryInput.instanceId = instanceId;

    const query = SummaryQuery(queryInput);
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
      return c.json({
        tenantId,
        agents: await getAnalyticsSummaryByAgent({
          db,
          tenantId,
          ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
          ...(query.instanceId !== undefined ? { instanceId: query.instanceId } : {}),
          ...(range !== undefined ? { range } : {}),
        }),
      });
    } catch (error) {
      log.error('Analytics by-agent query failed for tenant {tenantId}: {error}', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: { code: 'internal_error', message: 'Failed to query analytics' } },
        500
      );
    }
  };

  app.get('/summary', readGate, summaryHandler);
  app.get('/summary/by-agent', readGate, byAgentHandler);

  return app;
}
