/// <reference types="bun" />
import { describe, expect, it, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
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
  listWorkbenches: mock(() => Promise.resolve([])),
  listAgentInstances: mock(() => Promise.resolve([])),
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(React.createElement(QueryClientProvider, { client }, ui));
}

describe('LibraryRail', () => {
  it('renders real workflow sessions from the client', async () => {
    const { LibraryRail } = await import('./LibraryRail');
    renderWithClient(React.createElement(LibraryRail));

    await waitFor(() => {
      expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Sessions')).toBeDefined();
  });
});
