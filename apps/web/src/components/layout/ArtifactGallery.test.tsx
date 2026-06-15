/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import React from 'react';
import type { ArtifactWithSession } from '@workbench/shared';
import { ArtifactGallery } from './ArtifactGallery';

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

afterEach(cleanup);

// Seed the real useArtifacts query cache rather than module-mocking
// @workbench/client/react. Module mocks of that shared surface leak across the
// whole bun run (mock.module is applied globally at collection), poisoning the
// @workbench/client tests that import the real useArtifacts.
function renderWithSeededArtifacts(
  tenantId: string,
  artifacts: ArtifactWithSession[],
  ui: React.ReactElement
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['artifacts', tenantId, '', 'newest', '', ''], artifacts);
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(QueryClientProvider, { client }, ui)
    )
  );
}

describe('ArtifactGallery', () => {
  it('renders artifacts returned by the artifacts query', async () => {
    const view = renderWithSeededArtifacts(
      'tenant-workbench',
      [fakeArtifact],
      React.createElement(ArtifactGallery, { tenantId: 'tenant-workbench' })
    );

    await waitFor(() => {
      expect(view.getByText('Sales automation ROI')).toBeDefined();
    });
    expect(view.getByText('Acme Corp')).toBeDefined();
  });

  it('renders an empty state when the query returns no artifacts', async () => {
    const view = renderWithSeededArtifacts(
      'tenant-workbench',
      [],
      React.createElement(ArtifactGallery, { tenantId: 'tenant-workbench' })
    );

    await waitFor(() => {
      expect(view.queryByText('Sales automation ROI')).toBeNull();
    });
  });
});
