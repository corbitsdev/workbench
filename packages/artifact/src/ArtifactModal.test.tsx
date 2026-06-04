/// <reference types="bun" />
import './test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { ArtifactWithSession } from '@workbench/shared';
import { ArtifactModal } from './ArtifactModal';

const artifact: ArtifactWithSession = {
  id: 'a-1',
  sessionId: 'wf-1',
  parentId: null,
  painPointId: 'p-1',
  kind: 'email',
  title: 'Outreach email',
  content: 'Hello there',
  status: 'approved',
  version: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sessionName: 'Acme Corp',
  sessionStatus: 'done',
};

afterEach(cleanup);

describe('ArtifactModal', () => {
  it('renders nothing when closed', () => {
    render(React.createElement(ArtifactModal, { open: false, artifact, onClose: () => {} }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the artifact content when open', () => {
    render(React.createElement(ArtifactModal, { open: true, artifact, onClose: () => {} }));
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('Hello there')).toBeDefined();
    expect(screen.getByText('Outreach email')).toBeDefined();
  });

  it('closes on Escape', () => {
    const onClose = mock(() => {});
    render(React.createElement(ArtifactModal, { open: true, artifact, onClose }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on scrim click', () => {
    const onClose = mock(() => {});
    render(React.createElement(ArtifactModal, { open: true, artifact, onClose }));
    fireEvent.click(screen.getByTestId('artifact-modal-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the panel body is clicked', () => {
    const onClose = mock(() => {});
    render(React.createElement(ArtifactModal, { open: true, artifact, onClose }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('invokes an action callback with the artifact', () => {
    const onClick = mock(() => {});
    render(
      React.createElement(ArtifactModal, {
        open: true,
        artifact,
        onClose: () => {},
        actions: [{ label: 'Approve', onClick }],
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(artifact);
  });
});
