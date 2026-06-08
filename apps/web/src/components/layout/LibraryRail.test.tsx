/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react';
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
  deleteAgentInstance: mock(() => Promise.resolve()),
  listAvailableTools: mock(() => Promise.resolve([])),
  updateAgentTools: mock(() => Promise.resolve()),
  INFERENCE_PROVIDER_NAMES: ['anthropic', 'openai', 'google-genai', 'openai-compatible'],
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(React.createElement(QueryClientProvider, { client }, ui));
}

afterEach(cleanup);

describe('LibraryRail', () => {
  it('renders real jobs from the client', async () => {
    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      expect(view.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    });
    expect(view.getAllByText('Workflows').length).toBeGreaterThan(0);
  });

  it('renders the + button when onNew is provided and workbenches are present', async () => {
    const { listWorkbenches, listAgentInstances } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([{ id: 'wb-1', tenantId: 'tn-1', tenantSlug: 'acme', tenantName: 'Acme' }])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));

    const { LibraryRail } = await import('./LibraryRail');
    const props: LibraryRailProps = { onNew: () => void 0 };
    const view = renderWithClient(
      React.createElement(LibraryRail as React.FC<LibraryRailProps>, props)
    );

    await waitFor(() => {
      expect(view.getByRole('button', { name: 'New agent' })).toBeDefined();
    });
  });

  it('does not render the + button when onNew is not provided', async () => {
    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      expect(view.queryByRole('button', { name: 'New agent' })).toBeNull();
    });
  });

  it('only shows inference credentials in the agent credential editor', async () => {
    const { listWorkbenches, listAgentInstances, listEnrichedCredentials } =
      await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([{ id: 'wb-1', tenantId: 'tn-1', tenantSlug: 'acme', tenantName: 'Acme' }])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 'inst-1',
          agentId: 'ag-1',
          agentName: 'Loop',
          tenantId: 'tn-1',
          address: '',
          status: 'running',
          credentialRequirements: [
            { providerName: 'openai-compatible', source: 'tenant', name: 'Zen Test' },
          ],
          capabilities: null,
          createdAt: new Date().toISOString(),
        },
      ])
    );
    (listEnrichedCredentials as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 'cred-1',
          name: 'Zen Test',
          tenantId: 'tn-1',
          providerPlugin: 'openai-compatible',
          providerName: 'openai-compatible',
          providerId: 'pid-1',
          status: 'active',
          baseURL: '',
          model: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'cred-2',
          name: 'Exa Key',
          tenantId: 'tn-1',
          providerPlugin: 'exa',
          providerName: 'exa',
          providerId: 'pid-2',
          status: 'active',
          baseURL: '',
          model: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ])
    );

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(
      React.createElement(LibraryRail as React.FC<LibraryRailProps>, {
        activeWorkbenchSlug: 'acme',
        onAgentSelect: () => void 0,
      })
    );

    await waitFor(() => {
      expect(view.getByText('Loop')).toBeDefined();
    });

    fireEvent.click(view.getByRole('button', { name: 'Configure credential' }));

    await waitFor(() => {
      expect(view.getByRole('combobox')).toBeDefined();
    });

    const options = view.getAllByRole('option');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toContain('Zen Test');
    expect(options[0].textContent).not.toContain('Exa');
  });

  it('opens deployed agents so the chat can launch or show the real error', async () => {
    const { listWorkbenches, listAgentInstances } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([{ id: 'wb-1', tenantId: 'tn-1', tenantSlug: 'acme', tenantName: 'Acme' }])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 'inst-1',
          agentId: 'ag-1',
          agentName: 'Loop',
          tenantId: 'tn-1',
          address: '',
          status: 'deployed',
          credentialRequirements: [],
          capabilities: null,
          createdAt: new Date().toISOString(),
        },
      ])
    );
    const onAgentSelect = mock(() => undefined);

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(
      React.createElement(LibraryRail as React.FC<LibraryRailProps>, {
        activeWorkbenchSlug: 'acme',
        onAgentSelect,
      })
    );

    await waitFor(() => {
      expect(view.getByText('Loop')).toBeDefined();
    });

    fireEvent.click(view.getByText('Loop'));

    expect(onAgentSelect).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      tenantId: 'tn-1',
      agentName: 'Loop',
    });
  });

  it('keeps loaded agents visible and warns when one workbench fails to load agents', async () => {
    const { listWorkbenches, listAgentInstances } = await import('../../lib/hub-api');
    (listWorkbenches as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        { id: 'wb-1', tenantId: 'tn-ok', tenantSlug: 'acme', tenantName: 'Acme' },
        { id: 'wb-2', tenantId: 'tn-fail', tenantSlug: 'beta', tenantName: 'Beta' },
      ])
    );
    (listAgentInstances as ReturnType<typeof mock>).mockImplementation((tenantId: string) => {
      if (tenantId === 'tn-fail') return Promise.reject(new Error('forbidden'));
      return Promise.resolve([
        {
          id: 'inst-1',
          agentId: 'ag-1',
          agentName: 'Loop',
          tenantId,
          address: '',
          status: 'running',
          credentialRequirements: [],
          capabilities: null,
          createdAt: new Date().toISOString(),
        },
      ]);
    });

    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      expect(view.getByText('Loop')).toBeDefined();
    });

    expect(view.getByText('Some agents could not be loaded.')).toBeDefined();
  });
});
