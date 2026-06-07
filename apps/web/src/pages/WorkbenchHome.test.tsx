/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock approvals-api so ReviewGate does not attempt real network requests.
mock.module('../lib/approvals-api', () => ({
  listApprovals: () => Promise.resolve([]),
  approveRequest: () => Promise.resolve({}),
  rejectRequest: () => Promise.resolve({}),
}));

// Mock hub-api before importing WorkbenchHome so the provisioning guard and
// workbench list fetch resolve without hitting the network.
mock.module('../lib/hub-api', () => ({
  getMe: () =>
    Promise.resolve({
      userId: 'u1',
      personalTenantId: 'pt1',
      paInstanceId: 'inst-1',
      provisioned: true,
      credentialResolved: true,
    }),
  getMyPrincipals: () => Promise.resolve([]),
  createTenant: () => Promise.resolve({ id: 't1', name: 'Test', slug: 'test', domain: '' }),
  createWorkspace: () => Promise.resolve({ id: '', name: '', slug: '', tenantId: '' }),
  listWorkbenches: () =>
    Promise.resolve([
      { id: 'p-wb', tenantId: 'tn-wb', tenantSlug: 'acme-corp', tenantName: 'Acme Corp' },
    ]),
  getTenant: () =>
    Promise.resolve({
      id: '',
      name: '',
      slug: '',
      domain: '',
      parentId: null,
      createdAt: '',
      updatedAt: '',
    }),
  listTenantPrincipals: () => Promise.resolve([]),
  getPrincipal: () =>
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
    }),
  listTenantCredentials: () => Promise.resolve([]),
  listPrincipalGrants: () => Promise.resolve([]),
  listAgentInstances: () => Promise.resolve([]),
  createTenantCredential: () => Promise.resolve({ credentialId: '', providerId: '' }),
  deleteTenantCredential: () => Promise.resolve(),
  launchInstanceSession: () => Promise.resolve({ launched: true }),
  listEnrichedCredentials: () => Promise.resolve([]),
  provisionAgent: () =>
    Promise.resolve({ instanceId: '', agentId: '', agentName: '', tenantId: '' }),
  assignCredentialToAgent: () => Promise.resolve(),
}));

import WorkbenchHome from './WorkbenchHome';

// Force the mobile layout by stubbing matchMedia so the min-width query never
// matches. Stubbing the DOM (rather than mock.module) keeps this test isolated
// from sibling files — cross-file module mocks leak under bun.
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MemoryRouter, null, React.createElement(WorkbenchHome))
    )
  );
}

describe('WorkbenchHome mobile layout', () => {
  it('hides the library rail until the open button is pressed', async () => {
    renderHome();
    // Wait for provisioning guard to resolve before checking layout.
    const openBtn = await screen.findByRole('button', { name: /open library/i });
    expect(screen.queryByLabelText('Search workflows, agents')).toBeNull();
    expect(openBtn).toBeDefined();
  });

  it('opens the full-screen library overlay and closes it again', async () => {
    const user = userEvent.setup();
    renderHome();

    const openBtn = await screen.findByRole('button', { name: /open library/i });
    await user.click(openBtn);
    expect(screen.getByLabelText('Search workflows, agents')).toBeDefined();

    await user.click(screen.getByRole('button', { name: /close workbench/i }));
    expect(screen.queryByLabelText('Search workflows, agents')).toBeNull();
  });
});
