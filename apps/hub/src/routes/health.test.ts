import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';

function createHealthRoute() {
  const app = new Hono();

  app.get('/health', (c) => {
    return c.json({});
  });
  return app;
}

describe('GET /health', () => {
  it('returns 200 with empty response', async () => {
    const app = createHealthRoute();
    const res = await app.request('/health');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({});
  });
});
