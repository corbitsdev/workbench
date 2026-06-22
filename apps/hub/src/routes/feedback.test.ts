import { describe, expect, it, mock } from 'bun:test';
import type { DB } from '@intx/db';

mock.module('../config', () => ({
  getConfig: () => ({}),
}));

import { Hono } from 'hono';
import { createFeedbackRouter } from './feedback';

function makeRequest(
  url: string,
  opts: { method?: string; body?: unknown; userId?: string } = {}
): Request {
  const { method = 'POST', body, userId = 'user-1' } = opts;
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-user-id': userId,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function makeDb(overrides: Partial<DB['db']> = {}): DB['db'] {
  const fakePrincipal = {
    id: 'pri-1',
    tenantId: 'ten-1',
    kind: 'user',
    refId: 'user-1',
  };

  const db = {
    query: {
      principal: {
        findFirst: mock(async () => fakePrincipal),
      },
      agentInstance: {
        findFirst: mock(async () => ({ id: 'ins-1', tenantId: 'ten-1' })),
      },
    },
    insert: mock(() => ({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => Promise.resolve()),
      })),
    })),
    ...overrides,
  } as unknown as DB['db'];

  return db;
}

describe('POST /v1/feedback', () => {
  function setup(dbOverrides?: Partial<DB['db']>) {
    const db = makeDb(dbOverrides);
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use((c, next) => {
      c.set('userId', c.req.header('x-test-user-id') ?? '');
      return next();
    });
    app.route('/', createFeedbackRouter(db));
    return { app, db };
  }

  it('returns 201 on a valid thumbs-up for a turn_part', async () => {
    const { app } = setup();
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: 1 },
      })
    );
    expect(res.status).toBe(201);
  });

  it('returns 201 on a valid thumbs-down for a workflow_step', async () => {
    const { app } = setup();
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'step-abc', subjectKind: 'workflow_step', rating: -1 },
      })
    );
    expect(res.status).toBe(201);
  });

  it('returns 404 when the instance is not found', async () => {
    const { app } = setup({
      query: {
        agentInstance: { findFirst: mock(async () => null) },
        principal: { findFirst: mock(async () => null) },
      } as unknown as DB['db']['query'],
    });
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/missing/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: 1 },
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the caller is not a principal of the instance tenant', async () => {
    const { app } = setup({
      query: {
        agentInstance: {
          findFirst: mock(async () => ({ id: 'ins-1', tenantId: 'ten-1' })),
        },
        principal: { findFirst: mock(async () => null) },
      } as unknown as DB['db']['query'],
    });
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: 1 },
        userId: 'intruder',
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 on an invalid rating value', async () => {
    const { app } = setup();
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: 99 },
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on an invalid subjectKind', async () => {
    const { app } = setup();
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'unknown_kind', rating: 1 },
      })
    );
    expect(res.status).toBe(400);
  });
});
