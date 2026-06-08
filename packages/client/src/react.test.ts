/// <reference types="bun" />
// Behavioral contract tests for the React surface. These exercise the hooks
// against a real QueryClient with fetch mocked only at the boundary, pinning the
// query-key shape, the enabled-gating contract, and that successful data and
// propagated errors surface to consumers.
import './test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { ArtifactWithSession, WorkflowSummary } from '@workbench/shared';
import { useArtifacts, useLibraryResources } from './react';

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const spy = mock(impl);
  const fetcher = Object.assign((input: FetchArgs[0], init?: FetchArgs[1]) => spy(input, init), {
    preconnect: mock(() => {}),
  }) as unknown as typeof fetch;
  return { spy, fetcher };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const fakeWorkflow: WorkflowSummary = {
  id: 'wf-1',
  status: 'reviewing',
  createdAt: new Date().toISOString(),
  transcriptId: 'tx-1',
  companyName: 'Acme Corp',
  transcriptPreview: 'preview',
  painPointCount: 1,
  firstPainPoint: 'Manual entry',
};

const fakeArtifact: ArtifactWithSession = {
  id: 'art-1',
  sessionId: 'sess-1',
  parentId: null,
  painPointId: null,
  kind: 'email',
  title: 'Title',
  content: 'Body',
  status: 'draft',
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sessionName: 'Acme call',
  sessionStatus: 'reviewing',
};

afterEach(cleanup);

describe('useLibraryResources', () => {
  it('keys the query by tenantId so different tenants do not share a cache entry', () => {
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));
    const client = newClient();

    renderHook(
      () =>
        useLibraryResources(
          { baseUrl: 'http://localhost:4000', fetch: fetcher },
          { tenantId: 'tn-1' }
        ),
      { wrapper: wrapper(client) }
    );

    expect(client.getQueryCache().findAll({ queryKey: ['workflows', 'tn-1'] }).length).toBe(1);
  });

  it('stays disabled and does not fetch when tenantId is null', async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    const { result } = renderHook(
      () =>
        useLibraryResources(
          { baseUrl: 'http://localhost:4000', fetch: fetcher },
          { tenantId: null }
        ),
      { wrapper: wrapper(newClient()) }
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches workflows for the tenant and surfaces the data on success', async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([fakeWorkflow])));

    const { result } = renderHook(
      () =>
        useLibraryResources(
          { baseUrl: 'http://localhost:4000', fetch: fetcher },
          { tenantId: 'tn-1' }
        ),
      { wrapper: wrapper(newClient()) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([fakeWorkflow]);
    expect(spy.mock.calls[0]?.[0]).toBe('http://localhost:4000/api/v1/workflows?tenantId=tn-1');
  });

  it('surfaces a propagated server error to the consumer', async () => {
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse({ error: 'forbidden' }, 403)));

    const { result } = renderHook(
      () =>
        useLibraryResources(
          { baseUrl: 'http://localhost:4000', fetch: fetcher },
          { tenantId: 'tn-1' }
        ),
      { wrapper: wrapper(newClient()) }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe('forbidden');
  });
});

describe('useArtifacts', () => {
  it('keys the query by tenantId under the artifacts namespace', () => {
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));
    const client = newClient();

    renderHook(
      () =>
        useArtifacts({ baseUrl: 'http://localhost:4000', fetch: fetcher }, { tenantId: 'tn-9' }),
      { wrapper: wrapper(client) }
    );

    expect(client.getQueryCache().findAll({ queryKey: ['artifacts', 'tn-9'] }).length).toBe(1);
  });

  it('stays disabled and does not fetch when tenantId is null', () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    const { result } = renderHook(
      () => useArtifacts({ baseUrl: 'http://localhost:4000', fetch: fetcher }, { tenantId: null }),
      { wrapper: wrapper(newClient()) }
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches artifacts for the tenant and surfaces the data on success', async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([fakeArtifact])));

    const { result } = renderHook(
      () =>
        useArtifacts({ baseUrl: 'http://localhost:4000', fetch: fetcher }, { tenantId: 'tn-1' }),
      { wrapper: wrapper(newClient()) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([fakeArtifact]);
    expect(spy.mock.calls[0]?.[0]).toBe('http://localhost:4000/api/v1/artifacts?tenantId=tn-1');
  });
});
