/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, it, expect, mock, beforeEach } from 'bun:test';
import { cleanup, render, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnifiedCatalogModal } from './UnifiedCatalogModal';

mock.module('../../hooks/use-workflow', () => ({
  useWorkflowDeployments: () => ({
    data: [
      { deploymentId: 'dep-1', kind: 'collateral-generation', status: 'running', createdAt: '' },
      { deploymentId: 'dep-2', kind: 'presentation-generation', status: 'running', createdAt: '' },
      { deploymentId: 'dep-3', kind: 'seo-enrichment', status: 'running', createdAt: '' },
    ],
    isPending: false,
  }),
  useStartWorkflow: () => ({
    mutateAsync: async ({ kind }: { kind: string }) => ({ runId: `started-${kind}` }),
    isPending: false,
  }),
}));

// This mock must be a superset that also satisfies sibling files mocking the
// same hub-api module: bun applies mock.module globally for the whole run and
// the last registration wins, so two files mocking ../lib/hub-api with disjoint
// shapes break each other. Keep this in sync with WorkbenchHome.test's mock.
mock.module('../../lib/hub-api', () => ({
  listAgentTemplates: async () => [
    {
      key: 'oat',
      name: 'Oat',
      description: 'Granola notes agent',
      tools: ['granola_list_notes'],
    },
    {
      key: 'freddy',
      name: 'Freddy',
      description: 'Web research agent',
      tools: ['firecrawl_scrape'],
    },
  ],
  deployAgentFromTemplate: async (_tenantId: string, key: string) => ({ key }),
  getMe: () =>
    Promise.resolve({
      userId: 'u1',
      userName: 'Test User',
      personalTenantId: 'pt1',
      paInstanceId: 'inst-1',
      provisioned: true,
      credentialResolved: true,
    }),
  getMyPrincipals: () => Promise.resolve([]),
  listWorkbenches: () =>
    Promise.resolve([
      {
        id: 'p-wb',
        tenantId: 'tn-wb',
        tenantSlug: 'acme-corp',
        tenantName: 'Acme Corp',
      },
    ]),
  listAgentInstances: () => Promise.resolve([]),
  launchInstanceSession: () => Promise.resolve({ launched: true }),
}));

function screen() {
  return within(document.body);
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('UnifiedCatalogModal', () => {
  let onClose: ReturnType<typeof mock>;
  let onAgentDeployed: ReturnType<typeof mock>;
  let onWorkflowStarted: ReturnType<typeof mock>;

  beforeEach(() => {
    onClose = mock(() => undefined);
    onAgentDeployed = mock(() => undefined);
    onWorkflowStarted = mock(() => undefined);
  });

  afterEach(cleanup);

  it('renders the Agents tab by default with agent cards', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper }
    );

    await waitFor(() => screen().getByText('Oat'));
    screen().getByText('Freddy');
    screen().getByText('Granola notes agent');
  });

  it('shows tool provider labels on agent cards', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper }
    );

    await waitFor(() => screen().getByText('Oat'));
    screen().getByText('Granola');
    screen().getByText('Firecrawl');
  });

  it('switches to Workflows tab and shows workflow cards', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper }
    );

    fireEvent.click(screen().getByRole('button', { name: 'Workflows' }));

    await waitFor(() => screen().getByText('Collateral Generation'));
    screen().getByText('Presentation Generation');
    screen().getByText('SEO Enrichment');
  });

  it('filters agents by search query', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper }
    );

    await waitFor(() => screen().getByText('Oat'));

    const user = userEvent.setup();
    const searchInput = screen().getByPlaceholderText(/search/i);
    await user.type(searchInput, 'granola');

    screen().getByText('Oat');
    await waitFor(() => expect(screen().queryByText('Freddy')).toBeNull());
  });

  it('calls onAgentDeployed and onClose after successful deploy', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper }
    );

    await waitFor(() => screen().getByText('Oat'));
    const addButtons = screen().getAllByRole('button', { name: 'Add' });
    fireEvent.click(addButtons[0]!);

    await waitFor(() => expect(onAgentDeployed).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onWorkflowStarted with the new run id after clicking a workflow card', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper }
    );

    fireEvent.click(screen().getByRole('button', { name: 'Workflows' }));
    await waitFor(() => screen().getByText('Collateral Generation'));

    fireEvent.click(screen().getAllByRole('button', { name: 'Start' })[0]!);

    await waitFor(() =>
      expect(onWorkflowStarted).toHaveBeenCalledWith('started-collateral-generation')
    );
  });

  it('opens on the Workflows tab when defaultTab is workflows', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
        defaultTab="workflows"
      />,
      { wrapper }
    );

    await waitFor(() => screen().getByText('Collateral Generation'));
  });

  it('does not render when open is false', () => {
    render(
      <UnifiedCatalogModal
        open={false}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper }
    );

    expect(screen().queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape key', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper }
    );

    await waitFor(() => screen().getByRole('dialog'));
    fireEvent.keyDown(screen().getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
