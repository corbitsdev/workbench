/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, it, expect, mock, beforeEach } from 'bun:test';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnifiedCatalogModal } from './UnifiedCatalogModal';

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
  createWorkbench: () => Promise.resolve({ id: '', name: '', slug: '', tenantId: '' }),
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

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('UnifiedCatalogModal', () => {
  let onClose: ReturnType<typeof mock>;
  let onAgentDeployed: ReturnType<typeof mock>;
  let onWorkflowSelected: ReturnType<typeof mock>;

  beforeEach(() => {
    onClose = mock(() => undefined);
    onAgentDeployed = mock(() => undefined);
    onWorkflowSelected = mock(() => undefined);
  });

  afterEach(cleanup);

  it('renders the Agents tab by default with agent cards', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
      />,
      { wrapper }
    );

    await waitFor(() => screen.getByText('Oat'));
    screen.getByText('Freddy');
    screen.getByText('Granola notes agent');
  });

  it('shows tool provider labels on agent cards', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
      />,
      { wrapper }
    );

    await waitFor(() => screen.getByText('Oat'));
    screen.getByText('Granola');
    screen.getByText('Firecrawl');
  });

  it('switches to Workflows tab and shows workflow cards', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
      />,
      { wrapper }
    );

    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }));

    await waitFor(() => screen.getByText('Collateral Generation'));
    screen.getByText('Presentation Generation');
    screen.getByText('SEO Enrichment');
  });

  it('filters agents by search query', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
      />,
      { wrapper }
    );

    await waitFor(() => screen.getByText('Oat'));

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: 'granola' } });

    screen.getByText('Oat');
    expect(screen.queryByText('Freddy')).toBeNull();
  });

  it('calls onAgentDeployed and onClose after successful deploy', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
      />,
      { wrapper }
    );

    await waitFor(() => screen.getByText('Oat'));
    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    fireEvent.click(addButtons[0]!);

    await waitFor(() => expect(onAgentDeployed).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onWorkflowSelected with kind after clicking a workflow card', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
      />,
      { wrapper }
    );

    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }));
    await waitFor(() => screen.getByText('Collateral Generation'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Start' })[0]!);

    await waitFor(() => expect(onWorkflowSelected).toHaveBeenCalledWith('collateral-generation'));
  });

  it('opens on the Workflows tab when an artifact kind is provided', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
        artifactKind="email"
      />,
      { wrapper }
    );

    await waitFor(() => screen.getByText('Collateral Generation'));
  });

  it('does not render when open is false', () => {
    render(
      <UnifiedCatalogModal
        open={false}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
      />,
      { wrapper }
    );

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape key', async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onAgentDeployed={onAgentDeployed}
        onWorkflowSelected={onWorkflowSelected}
      />,
      { wrapper }
    );

    await waitFor(() => screen.getByRole('dialog'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
