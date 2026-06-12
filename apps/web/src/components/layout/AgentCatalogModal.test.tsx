/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { AgentCatalogEntry } from '../../lib/hub-api';

const mockEntries: AgentCatalogEntry[] = [
  { key: 'oat', name: 'Oat', description: 'Pulls meeting notes from Granola.' },
  { key: 'freddy', name: 'Freddy', description: 'Web research agent.' },
];

const mockDeploy = mock(() => Promise.resolve());

mock.module('../../lib/hub-api', () => ({
  listAgentTemplates: mock(() => Promise.resolve(mockEntries)),
  deployAgentFromTemplate: mockDeploy,
}));

import { AgentCatalogModal } from './AgentCatalogModal';

function renderModal(props: Partial<React.ComponentProps<typeof AgentCatalogModal>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = mock(() => {});
  const onDeployed = mock(() => {});

  const result = render(
    <QueryClientProvider client={queryClient}>
      <AgentCatalogModal
        open={props.open ?? true}
        tenantId={'tenantId' in props ? (props.tenantId ?? null) : 'tenant-1'}
        onClose={props.onClose ?? onClose}
        onDeployed={props.onDeployed ?? onDeployed}
      />
    </QueryClientProvider>
  );

  return { ...result, onClose, onDeployed };
}

afterEach(() => {
  cleanup();
  mockDeploy.mockReset();
});

describe('AgentCatalogModal', () => {
  it('renders nothing when closed', () => {
    const { queryByRole } = renderModal({ open: false });
    expect(queryByRole('dialog')).toBeNull();
  });

  it('renders the dialog with agent list when open', async () => {
    const { getByRole, findByText } = renderModal();
    getByRole('dialog');
    await findByText('Oat');
    await findByText('Freddy');
  });

  it('calls onClose when the close button is clicked', async () => {
    const { getByLabelText, onClose } = renderModal();
    await waitFor(() => getByLabelText('Close'));
    fireEvent.click(getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the scrim is clicked', async () => {
    const { getByTestId, onClose } = renderModal();
    await waitFor(() => getByTestId('agent-catalog-modal-scrim'));
    fireEvent.click(getByTestId('agent-catalog-modal-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deploys the selected agent and closes on success', async () => {
    const { findAllByRole, onClose, onDeployed } = renderModal();
    const addButtons = await findAllByRole('button', { name: 'Add' });
    await act(async () => {
      fireEvent.click(addButtons[0]!);
    });
    await waitFor(() => expect(mockDeploy).toHaveBeenCalledWith('tenant-1', 'oat'));
    expect(onClose).toHaveBeenCalled();
    expect(onDeployed).toHaveBeenCalled();
  });

  it('shows an error message when deployment fails', async () => {
    mockDeploy.mockImplementation(() => Promise.reject(new Error('Server error')));
    const { findAllByRole, findByText } = renderModal();
    const addButtons = await findAllByRole('button', { name: 'Add' });
    await act(async () => {
      fireEvent.click(addButtons[0]!);
    });
    await findByText('Server error');
  });

  it('disables all Add buttons while a deployment is in progress', async () => {
    let resolveDeployment!: () => void;
    mockDeploy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDeployment = resolve;
        })
    );
    const { findAllByRole } = renderModal();
    const addButtons = await findAllByRole('button', { name: 'Add' });
    fireEvent.click(addButtons[0]!);
    await waitFor(() => {
      const buttons = document.querySelectorAll('button[disabled]');
      expect(buttons.length).toBeGreaterThan(0);
    });
    resolveDeployment();
  });

  it('disables Add buttons when tenantId is null', async () => {
    const { findAllByRole } = renderModal({ tenantId: null });
    const addButtons = await findAllByRole('button', { name: 'Add' });
    for (const button of addButtons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
