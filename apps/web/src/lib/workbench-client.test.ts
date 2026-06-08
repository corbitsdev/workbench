/// <reference types="bun" />
import { describe, expect, it, mock } from 'bun:test';

interface QueryOptions {
  queryKey: unknown[];
}

const useQueryMock = mock((opts: QueryOptions) => opts);

mock.module('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
}));

import { listArtifacts } from '../../../../packages/client/src/index';
import { useArtifacts } from '../../../../packages/client/src/react';

describe('@workbench/client artifacts', () => {
  it('passes tenantId as a query parameter when provided', async () => {
    const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    );
    const fetcher: typeof fetch = Object.assign(
      (url: string | URL | Request, init?: RequestInit) => fetchMock(url, init),
      { preconnect: mock(() => {}) }
    );

    await listArtifacts(
      { baseUrl: 'http://localhost:4000', fetch: fetcher },
      { tenantId: 'tenant-workbench' }
    );

    const url = fetchMock.mock.calls[0]?.[0];
    expect(url).toBe('http://localhost:4000/api/v1/artifacts?tenantId=tenant-workbench');
  });

  it('includes tenantId in the artifacts query key', () => {
    useArtifacts({ baseUrl: 'http://localhost:4000' }, { tenantId: 'tenant-workbench' });

    const options = useQueryMock.mock.calls[0]?.[0];
    expect(options?.queryKey).toEqual(['artifacts', 'tenant-workbench']);
  });
});
