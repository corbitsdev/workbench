import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';

function createHealthRoute() {
  const app = new Hono();
  const startTime = Date.now();

  app.get('/health', (c) => {
    return c.json({
      status: 'connected',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });
  return app;
}

describe('GET /health', () => {
  it('returns 200 with connected status and uptime', async () => {
    const app = createHealthRoute();
    const res = await app.request('/health');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('connected');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});
