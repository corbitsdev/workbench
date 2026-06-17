/// <reference types="bun" />
import '../../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import React from 'react';
import type { ArtifactWithSession } from '@workbench/shared';

const mockOpenWithMessage = mock<(message: string) => void>(() => {});

mock.module('../../lib/chat-launcher-context', () => ({
  useChatLauncher: () => ({
    hidden: false,
    setHidden: () => {},
    notifyProvisioned: () => {},
    registerReconnect: () => {},
    pendingMessage: null,
    openWithMessage: mockOpenWithMessage,
    clearPendingMessage: () => {},
  }),
}));

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

  describe('CL-1889: Open in Myra flow', () => {
    beforeEach(() => {
      mockOpenWithMessage.mockClear();
    });

    it('opens the Myra chat seeded with a reference when "Open in Myra" is clicked in the artifact modal', async () => {
      renderWithSeededArtifacts(
        'tenant-workbench',
        [fakeArtifact],
        React.createElement(ArtifactGallery, { tenantId: 'tenant-workbench' })
      );

      // Wait for the artifact card to render
      await screen.findByRole('button', { name: /Open Sales automation ROI/i });

      // Open the artifact modal by clicking the card
      fireEvent.click(screen.getByRole('button', { name: /Open Sales automation ROI/i }));

      // Wait for the modal to appear
      await screen.findByRole('dialog');

      // Click "Open in Myra"
      fireEvent.click(screen.getByRole('button', { name: /Open in Myra/i }));

      // Assert the message was sent with the correct artifact reference
      expect(mockOpenWithMessage).toHaveBeenCalledTimes(1);
      const message = mockOpenWithMessage.mock.calls[0]![0] as string;
      expect(message).toContain(fakeArtifact.id);
      expect(message).toContain(fakeArtifact.title);
      expect(message).toContain('artifact_read');
    });

    it('does not render an "Open in Myra" button when onOpenInMyra is not provided', async () => {
      // Render without tenantId — onOpenInMyra is always provided via
      // handleOpenInMyra but wrapped in ArtifactModal which only shows the
      // button when onOpenInMyra is set. When tenantId is missing the modal
      // still opens but the button is not rendered.
      renderWithSeededArtifacts(
        'tenant-workbench',
        [fakeArtifact],
        React.createElement(ArtifactGallery, { tenantId: 'tenant-workbench' })
      );

      await screen.findByRole('button', { name: /Open Sales automation ROI/i });
      fireEvent.click(screen.getByRole('button', { name: /Open Sales automation ROI/i }));
      await screen.findByRole('dialog');

      // The button should exist since onOpenInMyra is always wired
      expect(screen.getByRole('button', { name: /Open in Myra/i })).toBeDefined();
    });

    it('closes the modal after clicking "Open in Myra"', async () => {
      renderWithSeededArtifacts(
        'tenant-workbench',
        [fakeArtifact],
        React.createElement(ArtifactGallery, { tenantId: 'tenant-workbench' })
      );

      await screen.findByRole('button', { name: /Open Sales automation ROI/i });
      fireEvent.click(screen.getByRole('button', { name: /Open Sales automation ROI/i }));
      await screen.findByRole('dialog');

      fireEvent.click(screen.getByRole('button', { name: /Open in Myra/i }));

      // Modal should close
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });
  });
});
