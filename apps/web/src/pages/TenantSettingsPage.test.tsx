/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import type {
  TenantDetailResponse,
  PrincipalDetail,
  CredentialDetail,
  Principal,
} from '../lib/hub-api';

const mockGetTenant = mock<(tenantId: string) => Promise<TenantDetailResponse>>();
const mockListTenantPrincipals = mock<(tenantId: string) => Promise<PrincipalDetail[]>>();
const mockListTenantCredentials = mock<(tenantId: string) => Promise<CredentialDetail[]>>();
const mockGetMyPrincipals = mock<() => Promise<Principal[]>>();

mock.module('../lib/hub-api', () => ({
  getMe: mock(() => Promise.resolve({ userId: 'u1', personalTenantId: null, provisionedAt: null })),
  getMyPrincipals: mockGetMyPrincipals,
  createTenant: mock(() => Promise.resolve({ id: 't1', name: '', slug: '', domain: '' })),
  createWorkbench: mock(() => Promise.resolve({ id: '', name: '', slug: '', tenantId: '' })),
  listWorkbenches: mock(() => Promise.resolve([])),
  getTenant: mockGetTenant,
  listTenantPrincipals: mockListTenantPrincipals,
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
  listTenantCredentials: mockListTenantCredentials,
  listPrincipalGrants: mock(() => Promise.resolve([])),
  listAgentInstances: mock(() => Promise.resolve([])),
  createTenantCredential: mock(() => Promise.resolve({ credentialId: '', providerId: '' })),
  deleteTenantCredential: mock(() => Promise.resolve()),
  launchInstanceSession: mock(() => Promise.resolve({ launched: true })),
  listEnrichedCredentials: mock(() => Promise.resolve([])),
  assignCredentialToAgent: mock(() => Promise.resolve()),
  provisionAgent: mock(() =>
    Promise.resolve({ instanceId: '', agentId: '', agentName: '', tenantId: '' })
  ),
}));

const TenantSettingsPage = require('./TenantSettingsPage').default;

function renderPage(tenantId = 'tenant-1') {
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/settings/tenants/${tenantId}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/settings/tenants/:tenantId',
          element: React.createElement(TenantSettingsPage),
        })
      )
    )
  );
}

const fakeTenant: TenantDetailResponse = {
  id: 'tenant-1',
  name: 'Acme Corp',
  slug: 'acme',
  domain: 'acme.example.com',
  parentId: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const fakePrincipal: PrincipalDetail = {
  id: 'principal-1',
  tenantId: 'tenant-1',
  kind: 'user',
  refId: 'user-1',
  displayName: 'Alice Example',
  email: 'alice@example.com',
  status: 'active',
  roles: [{ id: 'role-1', name: 'Admin' }],
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

afterEach(() => {
  cleanup();
  mockGetTenant.mockReset();
  mockListTenantPrincipals.mockReset();
  mockListTenantCredentials.mockReset();
  mockGetMyPrincipals.mockReset();
});

describe('TenantSettingsPage', () => {
  it('renders loading state initially', () => {
    mockGetTenant.mockReturnValue(new Promise(() => {}));
    mockListTenantPrincipals.mockReturnValue(new Promise(() => {}));
    mockListTenantCredentials.mockReturnValue(new Promise(() => {}));
    mockGetMyPrincipals.mockReturnValue(new Promise(() => {}));

    renderPage();

    const loadingEls = screen.getAllByText('Loading…');
    expect(loadingEls.length).toBeGreaterThan(0);
  });

  it('renders tenant name after getTenant resolves', async () => {
    mockGetTenant.mockResolvedValue(fakeTenant);
    mockListTenantPrincipals.mockResolvedValue([]);
    mockListTenantCredentials.mockResolvedValue([]);
    mockGetMyPrincipals.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeDefined();
    });
  });

  it('renders principal list after listTenantPrincipals resolves', async () => {
    mockGetTenant.mockResolvedValue(fakeTenant);
    mockListTenantPrincipals.mockResolvedValue([fakePrincipal]);
    mockListTenantCredentials.mockResolvedValue([]);
    mockGetMyPrincipals.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Alice Example')).toBeDefined();
    });
  });

  it('shows "No members found." when principals list is empty', async () => {
    mockGetTenant.mockResolvedValue(fakeTenant);
    mockListTenantPrincipals.mockResolvedValue([]);
    mockListTenantCredentials.mockResolvedValue([]);
    mockGetMyPrincipals.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No members found.')).toBeDefined();
    });
  });

  it('falls back to tenantId as heading when getTenant fails', async () => {
    mockGetTenant.mockRejectedValue(new Error('Network error'));
    mockListTenantPrincipals.mockResolvedValue([]);
    mockListTenantCredentials.mockResolvedValue([]);
    mockGetMyPrincipals.mockResolvedValue([]);

    renderPage('tenant-1');

    // The component falls back to the tenantId when getTenant rejects
    await waitFor(() => {
      expect(screen.getByText('tenant-1')).toBeDefined();
    });
  });
});
