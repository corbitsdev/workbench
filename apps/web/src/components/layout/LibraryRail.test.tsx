/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { LibraryRailProps } from './LibraryRail';
import type { WorkflowSummary } from '@workbench/shared';

const fakeWorkflow: WorkflowSummary = {
  id: 'wf-1',
  status: 'reviewing',
  createdAt: new Date().toISOString(),
  transcriptId: 'tx-1',
  companyName: 'Acme Corp',
  transcriptPreview: 'We struggle with manual data entry',
  painPointCount: 3,
  firstPainPoint: 'Manual data entry',
};

mock.module('@workbench/client/react', () => ({
  useLibraryResources: () => ({ data: [fakeWorkflow], isLoading: false, isError: false }),
  useArtifacts: () => ({ data: [], isLoading: false, isError: false }),
}));

mock.module('../../lib/hub-api', () => ({
  getMe: mock(() =>
    Promise.resolve({
      userId: '',
      userName: '',
      personalTenantId: null,
      paInstanceId: null,
      provisioned: false,
    })
  ),
  getMyPrincipals: mock(() => Promise.resolve([])),
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
  listTenantCredentials: mock(() => Promise.resolve([])),
  listPrincipalGrants: mock(() => Promise.resolve([])),
  listAgentInstances: mock(() => Promise.resolve([])),
  createTenantCredential: mock(() => Promise.resolve({ credentialId: '', providerId: '' })),
  deleteTenantCredential: mock(() => Promise.resolve()),
  launchInstanceSession: mock(() => Promise.resolve({ launched: true })),
  listEnrichedCredentials: mock(() => Promise.resolve([])),
  provisionAgent: mock(() =>
    Promise.resolve({ instanceId: '', agentId: '', agentName: '', tenantId: '' })
  ),
  assignCredentialToAgent: mock(() => Promise.resolve()),
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(React.createElement(QueryClientProvider, { client }, ui));
}

afterEach(cleanup);

describe('LibraryRail', () => {
  it('renders real workflow sessions from the client', async () => {
    const { LibraryRail } = await import('./LibraryRail');
    renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Sessions')).toBeDefined();
  });

  it('renders the + button when onNew is provided and workbenches are present', async () => {
    const { listWorkbenches, listAgentInstances } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([{ id: 'wb-1', tenantId: 'tn-1', tenantSlug: 'acme', tenantName: 'Acme' }])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));

    const { LibraryRail } = await import('./LibraryRail');
    const props: LibraryRailProps = { onNew: () => void 0 };
    renderWithClient(React.createElement(LibraryRail as React.FC<LibraryRailProps>, props));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New agent' })).toBeDefined();
    });
  });

  it('does not render the + button when onNew is not provided', async () => {
    const { LibraryRail } = await import('./LibraryRail');
    renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
    });
  });
});
