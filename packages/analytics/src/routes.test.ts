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

const byAgentRows = [
  {
    agentId: 'agt_myra',
    agentName: 'Myra',
    turnCount: summaryRow.turnCount,
    failedTurnCount: summaryRow.failedTurnCount,
    toolCallCount: summaryRow.toolCallCount,
    toolErrorCount: summaryRow.toolErrorCount,
    inputTokens: summaryRow.inputTokens,
    outputTokens: summaryRow.outputTokens,
    cacheReadTokens: summaryRow.cacheReadTokens,
    cacheWriteTokens: summaryRow.cacheWriteTokens,
    thinkingTokens: summaryRow.thinkingTokens,
  },
];

const byInstanceRows = [
  {
    instanceId: 'ins_1',
    agentId: 'agt_myra',
    agentName: 'Myra',
    turnCount: summaryRow.turnCount,
    failedTurnCount: summaryRow.failedTurnCount,
    toolCallCount: summaryRow.toolCallCount,
    toolErrorCount: summaryRow.toolErrorCount,
    inputTokens: summaryRow.inputTokens,
    outputTokens: summaryRow.outputTokens,
    cacheReadTokens: summaryRow.cacheReadTokens,
    cacheWriteTokens: summaryRow.cacheWriteTokens,
    thinkingTokens: summaryRow.thinkingTokens,
  },
];

mock.module('./queries', () => ({
  getAnalyticsSummary: mock(async () => summaryRow),
  getAnalyticsSummaryByAgent: mock(async () => byAgentRows),
  getAnalyticsSummaryByInstance: mock(async () => byInstanceRows),
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

describe('GET /summary/by-agent', () => {
  it('returns per-agent rollup rows for the tenant', async () => {
    const hub = new Hono<AnalyticsRouteEnv>();
    hub.use('/api/tenants/:tenantId/*', async (c, next) => {
      c.set('tenant', { id: 'tnt_ctx' });
      c.set('principal', { id: 'pri_1' });
      await next();
    });

    const passThrough = async (_c: { req: unknown }, next: () => Promise<void>) => {
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
      'http://localhost/api/tenants/tnt_ctx/analytics/summary/by-agent'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string; agents: { agentId: string }[] };
    expect(body.tenantId).toBe('tnt_ctx');
    expect(body.agents[0]?.agentId).toBe('agt_myra');
  });
});

describe('GET /summary/by-instance', () => {
  it('returns per-instance rollup rows for the tenant', async () => {
    const hub = new Hono<AnalyticsRouteEnv>();
    hub.use('/api/tenants/:tenantId/*', async (c, next) => {
      c.set('tenant', { id: 'tnt_ctx' });
      c.set('principal', { id: 'pri_1' });
      await next();
    });

    const passThrough = async (_c: { req: unknown }, next: () => Promise<void>) => {
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
      'http://localhost/api/tenants/tnt_ctx/analytics/summary/by-instance'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string; instances: { instanceId: string }[] };
    expect(body.tenantId).toBe('tnt_ctx');
    expect(body.instances[0]?.instanceId).toBe('ins_1');
  });
});
