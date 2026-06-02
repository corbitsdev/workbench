import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';

function createHealthRoute(getConnectedSidecarCount: () => number) {
  const app = new Hono();
  app.get('/health', (c) => {
    const sidecars = getConnectedSidecarCount();
    if (sidecars === 0) {
      return c.json({ status: 'starting', sidecars: 0 }, 503);
    }
    return c.json({
      status: 'ok',
      db: 'connected',
      auth: 'ready',
      sidecars,
      timestamp: new Date().toISOString(),
    });
  });
  return app;
}

describe('GET /health', () => {
  it('returns 503 with status starting when no sidecar is connected', async () => {
    const app = createHealthRoute(() => 0);
    const res = await app.request('/health');
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('starting');
    expect(body.sidecars).toBe(0);
  });

  it('returns 200 with status ok when sidecars are connected', async () => {
    const app = createHealthRoute(() => 3);
    const res = await app.request('/health');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.sidecars).toBe(3);
  });
});
