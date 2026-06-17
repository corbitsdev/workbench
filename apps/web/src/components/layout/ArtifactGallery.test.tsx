/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import React from 'react';
import type { ArtifactWithSession } from '@workbench/shared';
import { ArtifactGallery, buildArtifactMessage } from './ArtifactGallery';

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
  ownerPrincipalId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sessionName: 'Acme Corp',
  sessionStatus: 'done',
  ownerName: null,
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
  client.setQueryData(['artifacts', tenantId, '', 'newest', '', '', ''], artifacts);
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(QueryClientProvider, { client }, ui)
    )
  );
}

describe('buildArtifactMessage', () => {
  it('references the artifact by id and title without inlining its content', () => {
    const artifact: ArtifactWithSession = {
      ...fakeArtifact,
      id: 'a-42',
      title: 'Sales automation ROI',
      content: 'DISTINCTIVE_BODY_TEXT_should_not_be_sent',
    };
    const message = buildArtifactMessage(artifact);
    expect(message).toContain('a-42');
    expect(message).toContain('Sales automation ROI');
    expect(message).toContain('artifact_read');
    expect(message).not.toContain('DISTINCTIVE_BODY_TEXT_should_not_be_sent');
  });

  // Pins the message format the personal-agent prompt depends on: the `id:`
  // token plus the `artifact_read` tool name. A silent reword here would
  // decouple the message from the prompt nudge; this catches it.
  it('emits the id token and artifact_read tool name the prompt relies on', () => {
    const message = buildArtifactMessage(fakeArtifact);
    expect(message).toContain(`(id: ${fakeArtifact.id})`);
    expect(message).toContain('artifact_read');
  });

  it('escapes double quotes in the title so the framing cannot break', () => {
    const message = buildArtifactMessage({ ...fakeArtifact, title: 'Q3 "final" deck' });
    expect(message).toContain('"Q3 \\"final\\" deck"');
    expect(message).toContain(`(id: ${fakeArtifact.id})`);
  });

  it('refuses to reference an artifact with an empty id rather than emit a dead-end message', () => {
    expect(() => buildArtifactMessage({ ...fakeArtifact, id: '' })).toThrow();
  });
});

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
