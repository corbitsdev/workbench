/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  deleteAgentInstance,
  deployAgentFromTemplate,
  getMe,
  getMyPrincipals,
  getAnalyticsSummary,
  getOutputFeedback,
  launchInstanceSession,
  listAgentInstances,
  listAgentTemplates,
  listWorkbenches,
  principalsToWorkbenches,
  principalToWorkbenchEntry,
  stopAgentInstance,
  upsertRating,
  type Principal,
  type SavedRating,
} from './hub-api';

describe('principalsToWorkbenches', () => {
  it('filters out the global org tenant by id', () => {
    const principals: Principal[] = [
      {
        principalId: 'p-global',
        tenantId: 'tenant-global',
        tenantSlug: 'example-org',
        tenantName: 'Example Org',
        kind: 'user',
        status: 'active',
        roles: [],
      },
      {
        principalId: 'p-wb',
        tenantId: 'tenant-acme',
        tenantSlug: 'acme-sales',
        tenantName: 'Acme Sales',
        kind: 'user',
        status: 'active',
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, ['tenant-global']);

    expect(workbenches).toHaveLength(1);
    expect(workbenches[0]!.id).toBe('p-wb');
    expect(workbenches[0]!.tenantName).toBe('Acme Sales');
  });

  it('returns empty list when user has only the global org tenant', () => {
    const principals: Principal[] = [
      {
        principalId: 'p-global',
        tenantId: 'tenant-global',
        tenantSlug: 'example-org',
        tenantName: 'Example Org',
        kind: 'user',
        status: 'active',
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, ['tenant-global']);
    expect(workbenches).toHaveLength(0);
  });

  it('returns all principals when globalTenantId is null', () => {
    const principals: Principal[] = [
      {
        principalId: 'p-1',
        tenantId: 'tenant-acme',
        tenantSlug: 'acme-sales',
        tenantName: 'Acme Sales',
        kind: 'user',
        status: 'active',
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, [null]);
    expect(workbenches).toHaveLength(1);
  });

  it('maps Interchange principalId to the workbench entry id', () => {
    const principal: Principal = {
      principalId: 'principal-workbench',
      tenantId: 'tenant-acme',
      tenantSlug: 'acme-sales',
      tenantName: 'Acme Sales',
      kind: 'user',
      status: 'active',
      roles: [],
    };

    expect(principalToWorkbenchEntry(principal)).toEqual({
      id: 'principal-workbench',
      tenantId: 'tenant-acme',
      tenantSlug: 'acme-sales',
      tenantName: 'Acme Sales',
    });
  });
});

// Network helpers run through the real hubFetch by stubbing the global fetch
// boundary — no module mocking, so nothing leaks into other files (bun's
// mock.module is process-wide and survives mock.restore).
const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface StubResponse {
  ok?: boolean;
  status?: number;
  contentLength?: string | null;
  body?: unknown;
  bodyThrows?: boolean;
}

function installFetch(routes: (url: string) => StubResponse): FetchCall[] {
  const calls: FetchCall[] = [];
  const stub = mock((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes(url);
    const res = {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-length' ? (r.contentLength ?? null) : null,
      },
      json: () => (r.bodyThrows ? Promise.reject(new Error('not json')) : Promise.resolve(r.body)),
    };
    return Promise.resolve(res as unknown as Response);
  });
  globalThis.fetch = stub as unknown as typeof fetch;
  return calls;
}

describe('hub-api network helpers', () => {
  beforeEach(() => {
    (
      globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
    ).window.happyDOM.setURL('http://localhost/');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('getMe issues a credentialed GET to /api/v1/me and returns the parsed body', async () => {
    const me = { userId: 'u1', userName: 'Sawyer' };
    const calls = installFetch(() => ({ body: me }));

    expect((await getMe()) as unknown).toEqual(me);
    expect(calls[0]!.url).toContain('/api/v1/me');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.credentials).toBe('include');
  });

  it('getMyPrincipals unwraps the data envelope', async () => {
    const data = [{ principalId: 'p1' }];
    const calls = installFetch(() => ({ body: { data } }));

    expect((await getMyPrincipals()) as unknown).toEqual(data);
    expect(calls[0]!.url).toContain('/api/me/principals');
  });

  it('listWorkbenches joins principals with /me and excludes root tenants', async () => {
    installFetch((url) => {
      if (url.includes('/me/principals')) {
        return {
          body: {
            data: [
              { principalId: 'p-root', tenantId: 't-root' },
              { principalId: 'p-acme', tenantId: 't-acme', tenantSlug: 's', tenantName: 'Acme' },
            ],
          },
        };
      }
      return { body: { rootTenantIds: ['t-root'], personalTenantId: null } };
    });

    const workbenches = await listWorkbenches();
    expect(workbenches).toHaveLength(1);
    expect(workbenches[0]!.id).toBe('p-acme');
  });

  it('listWorkbenches falls back to personalTenantId when rootTenantIds is empty', async () => {
    installFetch((url) => {
      if (url.includes('/me/principals')) {
        return { body: { data: [{ principalId: 'p-personal', tenantId: 't-personal' }] } };
      }
      return { body: { rootTenantIds: [], personalTenantId: 't-personal' } };
    });

    expect(await listWorkbenches()).toHaveLength(0);
  });

  it('listAgentInstances encodes the tenantId query parameter', async () => {
    const calls = installFetch(() => ({ body: { data: [{ id: 'inst-1' }] } }));

    const instances = await listAgentInstances('tenant/with space');
    expect(instances as unknown).toEqual([{ id: 'inst-1' }]);
    expect(calls[0]!.url).toContain(`tenantId=${encodeURIComponent('tenant/with space')}`);
  });

  it('deleteAgentInstance issues a DELETE and tolerates a 204 with no body', async () => {
    const calls = installFetch(() => ({ status: 204, contentLength: '0', body: undefined }));

    await deleteAgentInstance('t1', 'inst-1');
    expect(calls[0]!.init?.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('/api/v1/tenants/t1/agents/instances/inst-1');
  });

  it('launchInstanceSession POSTs an empty object body', async () => {
    const calls = installFetch(() => ({ body: { launched: true } }));

    expect(await launchInstanceSession('inst-9')).toEqual({ launched: true });
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({});
  });

  it('stopAgentInstance DELETEs the instance', async () => {
    const calls = installFetch(() => ({ status: 204, contentLength: '0' }));

    await stopAgentInstance('t1', 'inst-2');
    expect(calls[0]!.init?.method).toBe('DELETE');
  });

  it('listAgentTemplates unwraps the data envelope', async () => {
    installFetch(() => ({ body: { data: [{ key: 'myra' }] } }));
    expect((await listAgentTemplates()) as unknown).toEqual([{ key: 'myra' }]);
  });

  it('deployAgentFromTemplate POSTs the templateKey', async () => {
    const calls = installFetch(() => ({ body: { instanceId: 'i1', created: true } }));

    await deployAgentFromTemplate('t1', 'oat');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ templateKey: 'oat' });
  });

  it('getAnalyticsSummary validates the response and passes date query params', async () => {
    const summary = {
      tenantId: 't1',
      turnCount: 10,
      failedTurnCount: 1,
      toolCallCount: 5,
      toolErrorCount: 0,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    };
    const calls = installFetch(() => ({ body: summary }));

    await expect(getAnalyticsSummary('t1', { startDate: '2026-06-01' })).resolves.toEqual(summary);
    expect(calls[0]!.url).toContain('/api/tenants/t1/analytics/summary');
    expect(calls[0]!.url).toContain('startDate=2026-06-01');
    expect(calls[0]!.init?.method).toBe('GET');
  });

  it('getAnalyticsSummary rejects malformed responses', async () => {
    installFetch(() => ({ body: { tenantId: 't1', turnCount: 'nope' } }));

    await expect(getAnalyticsSummary('t1')).rejects.toThrow(/Invalid analytics summary response/);
  });

  it('getOutputFeedback parses the ratings envelope and returns the array', async () => {
    const ratings = [
      { subjectId: 'tp-1', subjectKind: 'turn_part', rating: 1 },
      { subjectId: 'step-2', subjectKind: 'workflow_step', rating: -1 },
    ];
    const calls = installFetch(() => ({ body: { ratings } }));

    expect(await getOutputFeedback('inst-1')).toEqual(ratings as SavedRating[]);
    expect(calls[0]!.url).toContain('/api/v1/instances/inst-1/feedback');
    expect(calls[0]!.init?.method).toBe('GET');
  });

  it('getOutputFeedback rejects when the response fails schema validation', async () => {
    installFetch(() => ({
      body: { ratings: [{ subjectId: 'tp-1', subjectKind: 'turn_part', rating: 7 }] },
    }));

    await expect(getOutputFeedback('inst-1')).rejects.toThrow(/Malformed feedback response/);
  });

  it('getOutputFeedback rejects when the envelope shape is wrong', async () => {
    installFetch(() => ({ body: { notRatings: [] } }));

    await expect(getOutputFeedback('inst-1')).rejects.toThrow(/Malformed feedback response/);
  });

  it('throws with the server error message and status on a non-ok response', async () => {
    installFetch(() => ({ ok: false, status: 403, body: { error: 'forbidden' } }));

    await expect(getMe()).rejects.toMatchObject({ message: 'forbidden', status: 403 });
  });

  it('throws an HTTP fallback message when the error body is not JSON', async () => {
    installFetch(() => ({ ok: false, status: 500, bodyThrows: true }));

    await expect(getMe()).rejects.toMatchObject({ message: 'HTTP 500', status: 500 });
  });
});

describe('upsertRating', () => {
  it('appends a rating when none exists for the subject', () => {
    const next: SavedRating = { subjectId: 'tp-1', subjectKind: 'turn_part', rating: 1 };
    expect(upsertRating([], next)).toEqual([next]);
    expect(upsertRating(undefined, next)).toEqual([next]);
  });

  it('replaces the existing rating for the same subject without duplicating', () => {
    const prev: SavedRating[] = [{ subjectId: 'tp-1', subjectKind: 'turn_part', rating: 1 }];
    const next: SavedRating = { subjectId: 'tp-1', subjectKind: 'turn_part', rating: -1 };

    const result = upsertRating(prev, next);
    expect(result).toHaveLength(1);
    expect(result[0]!.rating).toBe(-1);
  });

  it('treats a different subjectKind for the same id as a distinct subject', () => {
    const prev: SavedRating[] = [{ subjectId: 's-1', subjectKind: 'turn_part', rating: 1 }];
    const next: SavedRating = { subjectId: 's-1', subjectKind: 'workflow_step', rating: 1 };

    const result = upsertRating(prev, next);
    expect(result).toHaveLength(2);
  });

  it('leaves other subjects untouched', () => {
    const prev: SavedRating[] = [
      { subjectId: 'tp-1', subjectKind: 'turn_part', rating: 1 },
      { subjectId: 'tp-2', subjectKind: 'turn_part', rating: 1 },
    ];
    const next: SavedRating = { subjectId: 'tp-1', subjectKind: 'turn_part', rating: -1 };

    const result = upsertRating(prev, next);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.subjectId === 'tp-2')!.rating).toBe(1);
  });
});
