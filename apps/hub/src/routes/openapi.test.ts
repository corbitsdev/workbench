import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { openAPIRouteHandler, describeRoute } from 'hono-openapi';

// Mirrors the parent-app /openapi.json wiring in index.ts: the handler is
// registered before sub-apps mount, yet walks app.routes lazily so it still
// captures routes mounted afterwards.
function createOpenApiApp(baseUrl: string) {
  const app = new Hono();

  app.get(
    '/openapi.json',
    openAPIRouteHandler(app, {
      documentation: {
        info: { title: 'GTM Workbench', version: '1.0.0' },
        servers: [{ url: baseUrl }],
      },
      exclude: ['/openapi.json', '/health', '/status', /^\/api\/auth\//],
    })
  );

  // Only describeRoute-annotated routes appear in the spec; plain routes are
  // omitted. The annotated route is mounted via a sub-app AFTER the handler is
  // registered, exercising the lazy route-walk that captures our real routers.
  const sub = new Hono();
  sub.get(
    '/api/v1/workflow-runs',
    describeRoute({ responses: { 200: { description: 'ok' } } }),
    (c) => c.json([])
  );
  sub.get('/api/auth/sign-in', (c) => c.json({}));
  sub.get('/health', (c) => c.json({}));
  app.route('/', sub);

  return app;
}

describe('GET /openapi.json', () => {
  it('returns 200 with a valid OpenAPI document', async () => {
    const app = createOpenApiApp('https://hub.example.com');
    const res = await app.request('/openapi.json');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
    };
    expect(body.openapi).toMatch(/^3\./);
    expect(body.info.title).toBe('GTM Workbench');
    expect(body.info.version).toBe('1.0.0');
  });

  it('includes the configured server URL', async () => {
    const app = createOpenApiApp('https://hub.example.com');
    const res = await app.request('/openapi.json');
    const body = (await res.json()) as { servers: { url: string }[] };

    expect(body.servers).toEqual([{ url: 'https://hub.example.com' }]);
  });

  it('captures routes mounted after the handler is registered', async () => {
    const app = createOpenApiApp('https://hub.example.com');
    const res = await app.request('/openapi.json');
    const body = (await res.json()) as { paths?: Record<string, unknown> };

    expect(body.paths?.['/api/v1/workflow-runs']).toBeDefined();
  });

  it('excludes /api/auth and /health routes from the spec', async () => {
    const app = createOpenApiApp('https://hub.example.com');
    const res = await app.request('/openapi.json');
    const body = (await res.json()) as { paths?: Record<string, unknown> };

    const paths = Object.keys(body.paths ?? {});
    expect(paths.some((p) => p.startsWith('/api/auth'))).toBe(false);
    expect(body.paths?.['/health']).toBeUndefined();
  });
});
