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
  getMyPrincipals: mock(() => Promise.resolve(mockPrincipals)),
  listTenantCredentials: mock(() => Promise.resolve(mockCredentials)),
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
