/// <reference types="bun" />
import '../../test-setup';
import { describe, expect, it, mock } from 'bun:test';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { ArtifactWithSession } from '@workbench/shared';

const fakeArtifact: ArtifactWithSession = {
  id: 'a-1',
  sessionId: 'wf-1',
  parentId: null,
  painPointId: 'p-1',
  kind: 'email',
  title: 'Sales automation ROI',
  content: 'body',
  status: 'approved',
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sessionName: 'Acme Corp',
  sessionStatus: 'done',
};

const mockUseArtifacts = mock((_options?: unknown, _params?: { tenantId?: string | null }) => ({
  data: [fakeArtifact],
  isLoading: false,
  isError: false,
}));

mock.module('@workbench/client/react', () => ({
  useArtifacts: mockUseArtifacts,
  useLibraryResources: () => ({ data: [], isLoading: false, isError: false }),
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(React.createElement(QueryClientProvider, { client }, ui));
}

describe('ArtifactGallery', () => {
  it('renders real artifacts from the client', async () => {
    const { ArtifactGallery } = await import('./ArtifactGallery');
    const view = renderWithClient(React.createElement(ArtifactGallery, {}));

    await waitFor(() => {
      expect(view.getByText('Sales automation ROI')).toBeDefined();
    });
    expect(view.getByText('Acme Corp')).toBeDefined();
  });

  it('passes tenantId through to the artifacts hook', async () => {
    const { ArtifactGallery } = await import('./ArtifactGallery');
    renderWithClient(React.createElement(ArtifactGallery, { tenantId: 'tenant-workspace' }));

    await waitFor(() => {
      expect(mockUseArtifacts).toHaveBeenCalled();
    });
    const lastCall = mockUseArtifacts.mock.calls[mockUseArtifacts.mock.calls.length - 1];
    expect(lastCall?.[1]).toEqual({ tenantId: 'tenant-workspace' });
  });
});
