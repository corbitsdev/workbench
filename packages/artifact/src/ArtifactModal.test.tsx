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
  ownerPrincipalId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sessionName: 'Acme Corp',
  sessionStatus: 'done',
  ownerName: null,
};

afterEach(cleanup);

describe('ArtifactModal', () => {
  it('renders nothing when closed', () => {
    render(React.createElement(ArtifactModal, { open: false, artifact, onClose: () => {} }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the artifact content when open', () => {
    render(React.createElement(ArtifactModal, { open: true, artifact, onClose: () => {} }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(screen.queryByText('Hello there')).not.toBeNull();
    expect(screen.queryByText('Outreach email')).not.toBeNull();
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

  it('wraps focus from the last element back to the first on Tab', () => {
    render(
      React.createElement(ArtifactModal, {
        open: true,
        artifact,
        onClose: () => {},
        actions: [{ label: 'Approve', onClick: () => {} }],
      })
    );
    const dialog = screen.getByRole('dialog');
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('wraps focus from the first element to the last on Shift+Tab', () => {
    render(
      React.createElement(ArtifactModal, {
        open: true,
        artifact,
        onClose: () => {},
        actions: [{ label: 'Approve', onClick: () => {} }],
      })
    );
    const dialog = screen.getByRole('dialog');
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('copies the artifact content to the clipboard and shows a copied state', async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(React.createElement(ArtifactModal, { open: true, artifact, onClose: () => {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy content' }));
    expect(writeText).toHaveBeenCalledWith('Hello there');
    await screen.findByRole('button', { name: 'Copied' });
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

  describe('CL-1638: Use in Workflow button', () => {
    it('renders the button when canUseInWorkflow returns true', () => {
      render(
        React.createElement(ArtifactModal, {
          open: true,
          artifact,
          onClose: () => {},
          onUseInWorkflow: () => {},
          canUseInWorkflow: () => true,
        })
      );
      expect(screen.queryByRole('button', { name: 'Use in Workflow' })).not.toBeNull();
    });

    it('hides the button when canUseInWorkflow returns false', () => {
      render(
        React.createElement(ArtifactModal, {
          open: true,
          artifact,
          onClose: () => {},
          onUseInWorkflow: () => {},
          canUseInWorkflow: () => false,
        })
      );
      expect(screen.queryByRole('button', { name: 'Use in Workflow' })).toBeNull();
    });

    it('offers the action for any artifact when no predicate is given', () => {
      render(
        React.createElement(ArtifactModal, {
          open: true,
          artifact,
          onClose: () => {},
          onUseInWorkflow: () => {},
        })
      );
      expect(screen.queryByRole('button', { name: 'Use in Workflow' })).not.toBeNull();
    });

    it('does not render the button when onUseInWorkflow is absent', () => {
      render(
        React.createElement(ArtifactModal, {
          open: true,
          artifact,
          onClose: () => {},
          canUseInWorkflow: () => true,
        })
      );
      expect(screen.queryByRole('button', { name: 'Use in Workflow' })).toBeNull();
    });

    it('calls onUseInWorkflow with the artifact on click', () => {
      const onUseInWorkflow = mock(() => {});
      render(
        React.createElement(ArtifactModal, {
          open: true,
          artifact,
          onClose: () => {},
          onUseInWorkflow,
          canUseInWorkflow: () => true,
        })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Use in Workflow' }));
      expect(onUseInWorkflow).toHaveBeenCalledTimes(1);
      expect(onUseInWorkflow).toHaveBeenCalledWith(artifact);
    });
  });

  describe('CL-1937: Open in Myra action', () => {
    it('invokes onOpenInMyra with the artifact when the button is clicked', () => {
      const onOpenInMyra = mock(() => {});
      render(
        React.createElement(ArtifactModal, {
          open: true,
          artifact,
          onClose: () => {},
          onOpenInMyra,
        })
      );
      fireEvent.click(screen.getByRole('button', { name: /Open in Myra/i }));
      expect(onOpenInMyra).toHaveBeenCalledTimes(1);
      expect(onOpenInMyra).toHaveBeenCalledWith(artifact);
    });

    it('does not render an Open in Myra control when onOpenInMyra is absent', () => {
      render(
        React.createElement(ArtifactModal, {
          open: true,
          artifact,
          onClose: () => {},
        })
      );
      expect(screen.queryByRole('button', { name: /Open in Myra/i })).toBeNull();
    });
  });
});
