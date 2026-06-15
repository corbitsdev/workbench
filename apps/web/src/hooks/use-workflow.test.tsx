/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useApproveArtifact,
  useCreateWorkflow,
  useEnabledWorkflows,
  useInstallWorkflow,
  useRunStep,
  useUpdateCompanyName,
  useUpdateStepConfig,
  useWorkbenchAgents,
  useWorkflow,
  useWorkflowCatalog,
  useWorkflowTools,
  useWorkflowTypes,
} from './use-workflow';

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];

// Route by URL so the multi-call hooks (useWorkbenchAgents fans out to
// listWorkbenches → /me/principals + /me, then listAgentInstances) resolve.
function installFetch(routes: (url: string) => { ok?: boolean; status?: number; body?: unknown }) {
  calls = [];
  const stub = mock((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes(url);
    const res = {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: { get: () => null },
      json: () => Promise.resolve(r.body),
    };
    return Promise.resolve(res as unknown as Response);
  });
  globalThis.fetch = stub as unknown as typeof fetch;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  (
    globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
  ).window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('use-workflow query hooks', () => {
  it('useWorkflowTypes fetches the workflow types catalog', async () => {
    installFetch(() => ({ body: [{ kind: 'collateral-generation', name: 'Collateral' }] }));
    const { result } = renderHook(() => useWorkflowTypes(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(calls[0]!.url).toContain('/workflows/types');
  });

  it('useWorkflow fetches a single workflow by id', async () => {
    installFetch(() => ({ body: { id: 'wf-1', currentStep: 'analyze', status: 'analyzing' } }));
    const { result } = renderHook(() => useWorkflow('wf-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe('wf-1');
    expect(calls[0]!.url).toContain('/workflows/wf-1');
  });

  it('useWorkflow stays disabled when no id is provided', () => {
    installFetch(() => ({ body: {} }));
    const { result } = renderHook(() => useWorkflow(''), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(calls).toHaveLength(0);
  });

  it('useWorkflowCatalog fetches the catalog', async () => {
    installFetch(() => ({ body: [{ kind: 'k', name: 'n', description: 'd', steps: [] }] }));
    const { result } = renderHook(() => useWorkflowCatalog(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]!.url).toContain('/workflows/catalog');
  });

  it('useWorkflowTools fetches tool metadata', async () => {
    installFetch(() => ({ body: [{ name: 't', providerName: 'p', description: 'd' }] }));
    const { result } = renderHook(() => useWorkflowTools(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]!.url).toContain('/workflows/tools');
  });

  it('useEnabledWorkflows scopes by tenantId when given one', async () => {
    installFetch(() => ({ body: [] }));
    const { result } = renderHook(() => useEnabledWorkflows('tenant-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]!.url).toContain(`tenantId=${encodeURIComponent('tenant-1')}`);
  });

  it('useEnabledWorkflows omits the tenant query when none is given', async () => {
    installFetch(() => ({ body: [] }));
    const { result } = renderHook(() => useEnabledWorkflows(null), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]!.url).toContain('/workflows/enabled');
    expect(calls[0]!.url).not.toContain('tenantId=');
  });

  it('useWorkbenchAgents fans out across workbenches and flattens the result', async () => {
    installFetch((url) => {
      if (url.includes('/me/principals')) {
        return { body: { data: [{ principalId: 'p1', tenantId: 't-acme' }] } };
      }
      if (url.includes('/api/v1/me')) {
        return { body: { rootTenantIds: [], personalTenantId: null } };
      }
      // listAgentInstances
      return { body: { data: [{ id: 'inst-1', tenantId: 't-acme' }] } };
    });

    const { result } = renderHook(() => useWorkbenchAgents(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data as unknown).toEqual([{ id: 'inst-1', tenantId: 't-acme' }]);
  });

  it('useWorkbenchAgents tolerates a per-workbench listing failure', async () => {
    installFetch((url) => {
      if (url.includes('/me/principals')) {
        return { body: { data: [{ principalId: 'p1', tenantId: 't-acme' }] } };
      }
      if (url.includes('/api/v1/me')) {
        return { body: { rootTenantIds: [], personalTenantId: null } };
      }
      return { ok: false, status: 500, body: { error: 'boom' } };
    });

    const { result } = renderHook(() => useWorkbenchAgents(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('useWorkbenchAgents does not fetch when disabled', () => {
    installFetch(() => ({ body: { data: [] } }));
    const { result } = renderHook(() => useWorkbenchAgents({ enabled: false }), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(calls).toHaveLength(0);
  });
});

describe('use-workflow mutation hooks', () => {
  it('useRunStep posts the step payload', async () => {
    installFetch(() => ({ body: { id: 'wf-1', currentStep: 'generate' } }));
    const { result } = renderHook(() => useRunStep('wf-1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ step: 'analyze' });
    });
    expect(calls[0]!.url).toContain('/workflows/wf-1/steps');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ step: 'analyze' });
  });

  it('useRunStep surfaces a rejection', async () => {
    installFetch(() => ({ ok: false, status: 500, body: { error: 'fail' } }));
    const { result } = renderHook(() => useRunStep('wf-1'), { wrapper });

    await expect(result.current.mutateAsync({ step: 'analyze' })).rejects.toMatchObject({
      status: 500,
    });
  });

  it('useApproveArtifact patches the artifact status', async () => {
    installFetch(() => ({ body: {} }));
    const { result } = renderHook(() => useApproveArtifact('wf-1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ artifactId: 'a1', status: 'approved' });
    });
    expect(calls[0]!.url).toContain('/workflows/wf-1/artifacts/a1/status');
    expect(calls[0]!.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: 'approved' });
  });

  it('useUpdateCompanyName patches the company name', async () => {
    installFetch(() => ({ body: { id: 'wf-1', companyName: 'Acme' } }));
    const { result } = renderHook(() => useUpdateCompanyName('wf-1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('Acme');
    });
    expect(calls[0]!.url).toContain('/workflows/wf-1/company');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ companyName: 'Acme' });
  });

  it('useUpdateStepConfig patches the step config', async () => {
    installFetch(() => ({ body: { id: 'wf-1', stepConfig: {} } }));
    const { result } = renderHook(() => useUpdateStepConfig('wf-1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ analyze: { maxOutputTokens: 100 } });
    });
    expect(calls[0]!.url).toContain('/workflows/wf-1/step-config');
  });

  it('useUpdateStepConfig surfaces a rejection', async () => {
    installFetch(() => ({ ok: false, status: 400, body: { error: 'bad' } }));
    const { result } = renderHook(() => useUpdateStepConfig('wf-1'), { wrapper });

    await expect(result.current.mutateAsync({})).rejects.toMatchObject({ status: 400 });
  });

  it('useInstallWorkflow posts the kind and assignments, including tenantId when set', async () => {
    installFetch(() => ({ body: { id: 'ew-1', kind: 'k' } }));
    const { result } = renderHook(() => useInstallWorkflow('tenant-1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ kind: 'k', assignments: {} });
    });
    expect(calls[0]!.url).toContain('/workflows/enabled');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      kind: 'k',
      assignments: {},
      tenantId: 'tenant-1',
    });
  });

  it('useInstallWorkflow surfaces a rejection', async () => {
    installFetch(() => ({ ok: false, status: 500, body: { error: 'fail' } }));
    const { result } = renderHook(() => useInstallWorkflow(), { wrapper });

    await expect(result.current.mutateAsync({ kind: 'k', assignments: {} })).rejects.toMatchObject({
      status: 500,
    });
  });

  it('useCreateWorkflow posts the creation body', async () => {
    installFetch(() => ({ body: { id: 'wf-new' } }));
    const { result } = renderHook(() => useCreateWorkflow(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ source: 'paste', workflowKind: 'collateral-generation' });
    });
    expect(calls[0]!.url).toContain('/workflows');
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ source: 'paste' });
  });

  it('useCreateWorkflow surfaces a rejection', async () => {
    installFetch(() => ({ ok: false, status: 422, body: { error: 'invalid' } }));
    const { result } = renderHook(() => useCreateWorkflow(), { wrapper });

    await expect(
      result.current.mutateAsync({ source: 'paste', workflowKind: 'collateral-generation' })
    ).rejects.toMatchObject({ status: 422 });
  });
});
