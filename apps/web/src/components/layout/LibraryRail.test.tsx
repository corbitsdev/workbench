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
  kind: 'collateral-generation',
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
      orgName: '',
      personalTenantId: null,
      paInstanceId: null,
      provisioned: false,
      credentialResolved: false,
    })
  ),
  getMyPrincipals: mock(() => Promise.resolve([])),
  createWorkbench: mock(() => Promise.resolve({ id: '', name: '', slug: '', tenantId: '' })),
  listWorkbenches: mock(() => Promise.resolve([])),
  listAgentInstances: mock(() => Promise.resolve([])),
  launchInstanceSession: mock(() => Promise.resolve({ launched: true })),
  deleteAgentInstance: mock(() => Promise.resolve()),
  stopAgentInstance: mock(() => Promise.resolve()),
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
      // Title shows the workflow type label; company name appears in the subtitle
      expect(view.getAllByText('Collateral Generation').length).toBeGreaterThan(0);
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
      expect(view.getByRole('button', { name: 'Add agent' })).toBeDefined();
    });
  });

  it('does not render the + button when onNew is not provided', async () => {
    const { LibraryRail } = await import('./LibraryRail');
    const view = renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      expect(view.queryByRole('button', { name: 'Add agent' })).toBeNull();
    });
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
