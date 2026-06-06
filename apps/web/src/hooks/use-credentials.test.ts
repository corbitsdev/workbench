/// <reference types="bun" />
import { describe, expect, it, mock } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { Principal, CredentialDetail } from '../lib/hub-api';

const mockPrincipals: Principal[] = [
  {
    id: 'p-1',
    tenantId: 't-1',
    tenantSlug: 'abk-labs',
    tenantName: 'ABK Labs',
    kind: 'user',
    status: 'active',
    roles: [],
  },
];

const mockCredentials: CredentialDetail[] = [
  {
    id: 'cred-1',
    tenantId: 't-1',
    providerId: 'granola',
    name: 'Granola API Key',
    type: 'api_key',
    status: 'active',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
];

mock.module('../lib/hub-api', () => ({
  getMe: mock(() =>
    Promise.resolve({
      userId: '',
      userName: '',
      personalTenantId: null,
      paInstanceId: null,
      provisioned: false,
    })
  ),
  getMyPrincipals: mock(() => Promise.resolve(mockPrincipals)),
  createTenant: mock(() => Promise.resolve({ id: '', name: '', slug: '', domain: '' })),
  createWorkspace: mock(() => Promise.resolve({ id: '', name: '', slug: '', tenantId: '' })),
  listWorkbenches: mock(() => Promise.resolve([])),
  getTenant: mock(() =>
    Promise.resolve({
      id: '',
      name: '',
      slug: '',
      domain: '',
      parentId: null,
      createdAt: '',
      updatedAt: '',
    })
  ),
  listTenantPrincipals: mock(() => Promise.resolve([])),
  getPrincipal: mock(() =>
    Promise.resolve({
      id: '',
      tenantId: '',
      kind: 'user',
      refId: '',
      displayName: '',
      status: 'active',
      roles: [],
      createdAt: '',
      updatedAt: '',
    })
  ),
  listTenantCredentials: mock(() => Promise.resolve(mockCredentials)),
  listPrincipalGrants: mock(() => Promise.resolve([])),
  listAgentInstances: mock(() => Promise.resolve([])),
  createTenantCredential: mock(() => Promise.resolve({ credentialId: '', providerId: '' })),
  deleteTenantCredential: mock(() => Promise.resolve()),
  launchInstanceSession: mock(() => Promise.resolve({ launched: true })),
  listEnrichedCredentials: mock(() => Promise.resolve([])),
  provisionAgent: mock(() =>
    Promise.resolve({ instanceId: '', agentId: '', agentName: '', tenantId: '' })
  ),
}));

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe('useCredentials', () => {
  it('returns principals and credentials by tenant after loading', async () => {
    const { useCredentials } = await import('./use-credentials');
    const { result } = renderHook(() => useCredentials(), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.principals).toEqual(mockPrincipals);
    expect(result.current.credentialsByTenant['t-1']).toEqual(mockCredentials);
  });

  it('starts in loading state', async () => {
    const { useCredentials } = await import('./use-credentials');
    const { result } = renderHook(() => useCredentials(), { wrapper: makeWrapper() });
    expect(result.current.isLoading).toBe(true);
  });
});
