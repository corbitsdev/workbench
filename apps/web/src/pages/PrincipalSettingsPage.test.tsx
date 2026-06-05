/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import type { PrincipalDetail, GrantDetail } from '../lib/hub-api';

const mockGetPrincipal =
  mock<(tenantId: string, principalId: string) => Promise<PrincipalDetail>>();
const mockListPrincipalGrants =
  mock<(tenantId: string, principalId: string) => Promise<GrantDetail[]>>();

mock.module('../lib/hub-api', () => ({
  getPrincipal: mockGetPrincipal,
  listPrincipalGrants: mockListPrincipalGrants,
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
  listTenantCredentials: mock(() => Promise.resolve([])),
  getMyPrincipals: mock(() => Promise.resolve([])),
  getMe: mock(() => Promise.resolve({ userId: 'u1', personalTenantId: null, provisionedAt: null })),
  listWorkbenches: mock(() => Promise.resolve([])),
  createTenant: mock(() => Promise.resolve({ id: '', name: '', slug: '', domain: '' })),
}));

const PrincipalSettingsPage = require('./PrincipalSettingsPage').default;

function renderPage(tenantId = 'tenant-1', principalId = 'principal-1') {
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/settings/tenants/${tenantId}/principals/${principalId}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/settings/tenants/:tenantId/principals/:principalId',
          element: React.createElement(PrincipalSettingsPage),
        })
      )
    )
  );
}

const fakePrincipal: PrincipalDetail = {
  id: 'principal-1',
  tenantId: 'tenant-1',
  kind: 'user',
  refId: 'user-1',
  displayName: 'Alice Example',
  email: 'alice@example.com',
  status: 'active',
  roles: [],
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const fakeGrant: GrantDetail = {
  id: 'grant-1',
  tenantId: 'tenant-1',
  resource: 'workbench/*',
  action: 'read',
  effect: 'allow',
  origin: 'role',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

afterEach(() => {
  cleanup();
  mockGetPrincipal.mockReset();
  mockListPrincipalGrants.mockReset();
});

describe('PrincipalSettingsPage', () => {
  it('renders loading state initially', () => {
    mockGetPrincipal.mockReturnValue(new Promise(() => {}));
    mockListPrincipalGrants.mockReturnValue(new Promise(() => {}));

    renderPage();

    const loadingEls = screen.getAllByText('Loading…');
    expect(loadingEls.length).toBeGreaterThan(0);
  });

  it('renders display name after APIs resolve', async () => {
    mockGetPrincipal.mockResolvedValue(fakePrincipal);
    mockListPrincipalGrants.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Alice Example')).toBeDefined();
    });
  });

  it('renders grants table when grants exist', async () => {
    mockGetPrincipal.mockResolvedValue(fakePrincipal);
    mockListPrincipalGrants.mockResolvedValue([fakeGrant]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('workbench/*')).toBeDefined();
    });
    expect(screen.getByText('read')).toBeDefined();
  });

  it('renders "No grants" when grants list is empty', async () => {
    mockGetPrincipal.mockResolvedValue(fakePrincipal);
    mockListPrincipalGrants.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No grants assigned to this principal.')).toBeDefined();
    });
  });

  it('gets tenantId and principalId from route params', async () => {
    mockGetPrincipal.mockResolvedValue(fakePrincipal);
    mockListPrincipalGrants.mockResolvedValue([]);

    renderPage('tenant-42', 'principal-1');

    await waitFor(() => {
      expect(screen.getByText('Alice Example')).toBeDefined();
    });

    expect(mockGetPrincipal).toHaveBeenCalledWith('tenant-42', 'principal-1');
    expect(mockListPrincipalGrants).toHaveBeenCalledWith('tenant-42', 'principal-1');
  });
});
