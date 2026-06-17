/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock approvals-api so ReviewGate does not attempt real network requests.
mock.module('../lib/approvals-api', () => ({
  listApprovals: () => Promise.resolve([]),
  approveRequest: () => Promise.resolve({}),
  rejectRequest: () => Promise.resolve({}),
}));

// Mock hub-api before importing WorkbenchHome so the provisioning guard and
// workbench list fetch resolve without hitting the network.
mock.module('../lib/hub-api', () => ({
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
      { id: 'p-wb', tenantId: 'tn-wb', tenantSlug: 'acme-corp', tenantName: 'Acme Corp' },
    ]),
  listAgentInstances: () => Promise.resolve([]),
  launchInstanceSession: () => Promise.resolve({ launched: true }),
  // Superset members so a sibling file mocking the same hub-api module (which
  // wins globally under bun's last-registration-wins mock.module) still has
  // these. Keep in sync with UnifiedCatalogModal.test's mock.
  listAgentTemplates: () =>
    Promise.resolve([
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
    ]),
  deployAgentFromTemplate: (_tenantId: string, key: string) => Promise.resolve({ key }),
}));

import type { ArtifactWithSession } from '@workbench/artifact';
import WorkbenchHome from './WorkbenchHome';

const TENANT_ID = 'tn-wb';

const fakeArtifact: ArtifactWithSession = {
  id: 'art-42',
  sessionId: 'wf-1',
  parentId: null,
  painPointId: null,
  kind: 'call-transcript',
  title: 'Acme call',
  content: 'transcript body',
  status: 'approved',
  version: 1,
  ownerPrincipalId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sessionName: 'Acme Corp',
  sessionStatus: 'done',
  ownerName: null,
};

// Force the mobile layout by stubbing matchMedia so the min-width query never
// matches. Stubbing the DOM (rather than mock.module) keeps this test isolated
// from sibling files — cross-file module mocks leak under bun.
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

function renderHome(initialPath = '/workbenches/acme-corp') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the artifact cache so useArtifacts resolves without a network call.
  // Key matches what @workbench/client builds: ['artifacts', tenantId, '', 'newest', '', '', ''].
  client.setQueryData(['artifacts', TENANT_ID, '', 'newest', '', '', ''], [fakeArtifact]);
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        React.createElement(WorkbenchHome)
      )
    )
  );
}

describe('WorkbenchHome artifact pre-seeding via URL', () => {
  it('opens the catalog modal when ?artifactId matches a loaded artifact', async () => {
    renderHome(`/workbenches/acme-corp?artifactId=${fakeArtifact.id}`);
    await screen.findByRole('dialog', { name: /add agent or workflow/i });
  });

  it('does not open the catalog modal when ?artifactId is absent', async () => {
    renderHome('/workbenches/acme-corp');
    // Wait for provisioning to settle, then assert no modal.
    await screen.findByRole('button', { name: /open library/i });
    expect(screen.queryByRole('dialog', { name: /add agent or workflow/i })).toBeNull();
  });

  it('does not open the catalog modal when ?artifactId does not match any artifact', async () => {
    renderHome('/workbenches/acme-corp?artifactId=does-not-exist');
    await screen.findByRole('button', { name: /open library/i });
    expect(screen.queryByRole('dialog', { name: /add agent or workflow/i })).toBeNull();
  });
});

describe('WorkbenchHome mobile layout', () => {
  it('hides the library rail until the open button is pressed', async () => {
    renderHome();
    // Wait for provisioning guard to resolve before checking layout.
    const openBtn = await screen.findByRole('button', { name: /open library/i });
    expect(screen.queryByLabelText('Search workflows, agents')).toBeNull();
    expect(openBtn).toBeDefined();
  });

  it('opens the full-screen library overlay and closes it again', async () => {
    const user = userEvent.setup();
    renderHome();

    const openBtn = await screen.findByRole('button', { name: /open library/i });
    await user.click(openBtn);
    expect(screen.getByLabelText('Search workflows, agents')).toBeDefined();

    await user.click(screen.getByRole('button', { name: /close workbench/i }));
    expect(screen.queryByLabelText('Search workflows, agents')).toBeNull();
  });
});
