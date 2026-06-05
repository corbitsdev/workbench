/// <reference types="bun" />
import { describe, expect, it, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
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

mock.module('@workbench/client/react', () => ({
  useArtifacts: () => ({ data: [fakeArtifact], isLoading: false, isError: false }),
  useLibraryResources: () => ({ data: [], isLoading: false, isError: false }),
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(React.createElement(QueryClientProvider, { client }, ui));
}

describe('ArtifactGallery', () => {
  it('renders real artifacts from the client', async () => {
    const { ArtifactGallery } = await import('./ArtifactGallery');
    renderWithClient(React.createElement(ArtifactGallery, {}));

    await waitFor(() => {
      expect(screen.getByText('Sales automation ROI')).toBeDefined();
    });
    expect(screen.getByText('Acme Corp')).toBeDefined();
  });
});
