import { describe, expect, mock, test } from 'bun:test';
import { type Context, Hono } from 'hono';

const errorCalls: Array<{ message: string; meta: unknown }> = [];
mock.module('@intx/log', () => ({
  getLogger: () => ({
    error: (message: string, meta: unknown) => {
      errorCalls.push({ message, meta });
    },
    info: () => {},
    warn: () => {},
    fatal: () => {},
    debug: () => {},
  }),
}));

const { serverErrorReporter, SERVER_ERROR_LOGGED } = await import('./server-error-logger');

type Vars = { Variables: { [SERVER_ERROR_LOGGED]?: boolean } };

function appWith(handler: (c: Context<Vars>) => Response): Hono<Vars> {
  const a = new Hono<Vars>();
  a.use('*', serverErrorReporter());
  a.get('/x', handler);
  return a;
}

describe('serverErrorReporter', () => {
  test('reports a handled 5xx response that never threw', async () => {
    errorCalls.length = 0;
    const a = appWith((c) => c.json({ error: 'boom' }, 503));
    const res = await a.request('/x');
    expect(res.status).toBe(503);
    expect(errorCalls).toHaveLength(1);
    const meta = errorCalls[0]?.meta as { status: number };
    expect(meta.status).toBe(503);
  });

  test('does not report a 2xx response', async () => {
    errorCalls.length = 0;
    const a = appWith((c) => c.json({ ok: true }, 200));
    await a.request('/x');
    expect(errorCalls).toHaveLength(0);
  });

  test('does not report a 4xx response (expected client error)', async () => {
    errorCalls.length = 0;
    const a = appWith((c) => c.json({ error: 'Forbidden' }, 403));
    await a.request('/x');
    expect(errorCalls).toHaveLength(0);
  });

  test('does not double-report a 5xx already logged by onError', async () => {
    errorCalls.length = 0;
    const a = appWith((c) => {
      c.set(SERVER_ERROR_LOGGED, true);
      return c.json({ error: 'Internal Server Error' }, 500);
    });
    await a.request('/x');
    expect(errorCalls).toHaveLength(0);
  });
});
