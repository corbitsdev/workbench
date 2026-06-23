import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createAnalyticsRoutes, type AnalyticsRouteEnv } from './routes';

const summaryRow = {
  tenantId: 'tnt_test',
  turnCount: 2,
  failedTurnCount: 0,
  toolCallCount: 1,
  toolErrorCount: 0,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  thinkingTokens: 0,
};

mock.module('./queries', () => ({
  getAnalyticsSummary: mock(async () => summaryRow),
}));

describe('GET /summary (nested under /api/tenants/:tenantId/analytics)', () => {
  it('returns summary using tenant from context when route param is not on child app', async () => {
    const hub = new Hono<AnalyticsRouteEnv>();
    hub.use('/api/tenants/:tenantId/*', async (c, next) => {
      c.set('tenant', { id: 'tnt_from_context' });
      c.set('principal', { id: 'pri_1' });
      await next();
    });

    const passThrough = async (c: { req: unknown }, next: () => Promise<void>) => {
      await next();
    };

    hub.route(
      '/api/tenants/:tenantId/analytics',
      createAnalyticsRoutes({
        db: {} as never,
        requireRead: passThrough as never,
      })
    );

    const res = await hub.request(
      'http://localhost/api/tenants/tnt_from_context/analytics/summary?startDate=2026-06-16'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof summaryRow;
    expect(body.turnCount).toBe(2);
  });
});