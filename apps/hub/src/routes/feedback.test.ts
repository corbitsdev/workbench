import { describe, expect, it, mock } from 'bun:test';
import type { HubDb } from '../db';

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

const fakeRatings = [
  { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: 1 },
  { subjectId: 'step-xyz', subjectKind: 'workflow_step', rating: -1 },
];

function makeDb(overrides: Partial<HubDb> = {}): HubDb {
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
      memberAgentInstance: {
        findFirst: mock(async () => ({ instanceId: 'ins-1', memberPrincipalId: 'pri-1' })),
      },
    },
    insert: mock(() => ({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => Promise.resolve()),
      })),
    })),
    select: mock(() => ({
      from: mock(() => ({
        where: mock(async () => fakeRatings),
      })),
    })),
    ...overrides,
  } as unknown as HubDb;

  return db;
}

describe('POST /v1/feedback', () => {
  function setup(dbOverrides?: Partial<HubDb>) {
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
        memberAgentInstance: { findFirst: mock(async () => null) },
      } as unknown as HubDb['query'],
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
        memberAgentInstance: { findFirst: mock(async () => null) },
      } as unknown as HubDb['query'],
    });
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: 1 },
        userId: 'intruder',
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the caller is not the instance owner', async () => {
    const { app } = setup({
      query: {
        agentInstance: {
          findFirst: mock(async () => ({ id: 'ins-1', tenantId: 'ten-1' })),
        },
        principal: {
          findFirst: mock(async () => ({
            id: 'pri-2',
            tenantId: 'ten-1',
            kind: 'user',
            refId: 'other-user',
          })),
        },
        memberAgentInstance: { findFirst: mock(async () => null) },
      } as unknown as HubDb['query'],
    });
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: 1 },
        userId: 'other-user',
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

  // SEAM UNCOVERED: the user-visible contract — "my thumb sticks after reload",
  // i.e. the (principal, subjectId, subjectKind) unique key de-dupes so a second
  // POST updates the existing row rather than inserting a duplicate, and a GET
  // reads back exactly that one row — has no integration coverage. This test only
  // asserts the route reaches `onConflictDoUpdate` with the new rating against a
  // fully mocked db; it cannot prove the Postgres upsert key actually de-dupes.
  // The hub has no real/testcontainer Postgres harness today (all route tests mock
  // `db`), so this is left as a wiring check. Closing the gap needs a real-DB
  // integration harness that runs migrations and exercises the route↔Postgres seam.
  it('calls onConflictDoUpdate so a second rating replaces the first', async () => {
    const onConflictDoUpdate = mock(() => Promise.resolve());
    const { app } = setup({
      insert: mock(() => ({
        values: mock(() => ({ onConflictDoUpdate })),
      })) as unknown as HubDb['insert'],
    });

    await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: 1 },
      })
    );
    await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        body: { subjectId: 'tp-abc', subjectKind: 'turn_part', rating: -1 },
      })
    );

    expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
    const secondCall = (onConflictDoUpdate.mock.calls[1] as unknown[])[0] as {
      set: { rating: number };
    };
    expect(secondCall.set.rating).toBe(-1);
  });
});

describe('GET /v1/instances/:instanceId/feedback', () => {
  function setup(dbOverrides?: Partial<HubDb>) {
    const db = makeDb(dbOverrides);
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use((c, next) => {
      c.set('userId', c.req.header('x-test-user-id') ?? '');
      return next();
    });
    app.route('/', createFeedbackRouter(db));
    return { app, db };
  }

  it('returns all ratings for the caller on this instance', async () => {
    const { app } = setup();
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ratings: unknown[] };
    expect(body.ratings).toHaveLength(2);
  });

  it('returns 404 when the instance is not found', async () => {
    const { app } = setup({
      query: {
        agentInstance: { findFirst: mock(async () => null) },
        principal: { findFirst: mock(async () => null) },
        memberAgentInstance: { findFirst: mock(async () => null) },
      } as unknown as HubDb['query'],
    });
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/missing/feedback', { method: 'GET' })
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
        memberAgentInstance: { findFirst: mock(async () => null) },
      } as unknown as HubDb['query'],
    });
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', {
        method: 'GET',
        userId: 'intruder',
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns an empty ratings array when the caller has no saved ratings', async () => {
    const { app } = setup({
      select: mock(() => ({
        from: mock(() => ({
          where: mock(async () => []),
        })),
      })) as unknown as HubDb['select'],
    });
    const res = await app.request(
      makeRequest('http://localhost/v1/instances/ins-1/feedback', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ratings: unknown[] };
    expect(body.ratings).toHaveLength(0);
  });
});
