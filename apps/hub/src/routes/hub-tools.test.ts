import { describe, expect, test } from 'bun:test';
import { createHubToolsRouter } from './hub-tools';

// artifact_list issues `db.select({...}).from().where().orderBy().limit()`,
// resolving to a rows array. This chainable fake satisfies that path so the
// authorized happy-path test exercises a real hub-backed tool end to end
// without mocking @intx/db.
function chainableSelect(rows: unknown[]): unknown {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'innerJoin']) {
    chain[method] = () => chain;
  }
  chain.limit = async () => rows;
  return chain;
}

type DbOpts = {
  toolNames: string[];
  agentTenantId?: string;
  instanceMatches?: boolean;
  creatorPrincipalId?: string;
};

function fakeDb(opts: DbOpts): Parameters<typeof createHubToolsRouter>[0] {
  return {
    select: () => chainableSelect([]),
    query: {
      agent: {
        findFirst: async () => ({
          tenantId: opts.agentTenantId ?? 't1',
          creatorPrincipalId: opts.creatorPrincipalId ?? 'owner1',
          capabilities: { tools: opts.toolNames },
        }),
      },
      agentInstance: {
        findFirst: async () =>
          (opts.instanceMatches ?? true) ? { id: 'i1', principalId: 'instance-owner' } : undefined,
      },
    },
  } as unknown as Parameters<typeof createHubToolsRouter>[0];
}

function makeRouter(toolNames: string[], extra: Omit<DbOpts, 'toolNames'> = {}) {
  return createHubToolsRouter(fakeDb({ toolNames, ...extra }), 'sidecar-token');
}

function post(
  router: ReturnType<typeof createHubToolsRouter>,
  body: unknown,
  token = 'sidecar-token'
) {
  return router.request('/hub-tools/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const baseCall = {
  tenantId: 't1',
  agentId: 'a1',
  principalId: 'p1',
  sessionId: 's1',
  args: {},
};

describe('POST /hub-tools/run', () => {
  test('rejects an unauthorized caller', async () => {
    const res = await post(
      makeRouter(['artifact_list']),
      { ...baseCall, toolName: 'artifact_list' },
      'wrong'
    );
    expect(res.status).toBe(401);
  });

  test('executes a hub-backed tool the agent is granted', async () => {
    const res = await post(makeRouter(['artifact_list']), {
      ...baseCall,
      toolName: 'artifact_list',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; isError: boolean };
    expect(body.isError).toBe(false);
    expect(JSON.parse(body.result)).toEqual({ artifacts: [] });
  });

  test('rejects a tool not in the agent capabilities with 403', async () => {
    const res = await post(makeRouter(['artifact_read']), {
      ...baseCall,
      toolName: 'artifact_list',
    });
    expect(res.status).toBe(403);
  });

  test('returns 404 for a tool that is not hub-backed', async () => {
    const res = await post(makeRouter(['hackernews_search']), {
      ...baseCall,
      toolName: 'hackernews_search',
    });
    expect(res.status).toBe(404);
  });

  test('rejects when the agent belongs to a different tenant (403)', async () => {
    const res = await post(makeRouter(['artifact_list'], { agentTenantId: 'other' }), {
      ...baseCall,
      toolName: 'artifact_list',
    });
    expect(res.status).toBe(403);
  });

  test('rejects a principalId that is not an instance of this agent (403)', async () => {
    const res = await post(makeRouter(['artifact_list'], { instanceMatches: false }), {
      ...baseCall,
      toolName: 'artifact_list',
    });
    expect(res.status).toBe(403);
  });

  test('allows deterministic workflow step agents without an instance row', async () => {
    const res = await post(makeRouter(['artifact_list'], { instanceMatches: false }), {
      ...baseCall,
      agentId: 'ins_ses_123-persist',
      principalId: 'ins_ses_123-persist',
      toolName: 'artifact_list',
    });
    expect(res.status).toBe(200);
  });
});
