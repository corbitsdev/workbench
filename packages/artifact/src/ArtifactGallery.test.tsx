/// <reference types="bun" />
import './test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { ArtifactWithSession } from '@workbench/shared';
import { ArtifactGallery } from './ArtifactGallery';
import { ArtifactCard } from './ArtifactCard';
import { toGalleryArtifact } from './artifact-visuals';

afterEach(cleanup);

const artifact: ArtifactWithSession = {
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

describe('ArtifactCard', () => {
  it('renders title and from label', () => {
    render(React.createElement(ArtifactCard, { artifact: toGalleryArtifact(artifact), index: 1 }));
    expect(screen.getByText('Sales automation ROI')).toBeDefined();
    expect(screen.getByText('Acme Corp')).toBeDefined();
  });

  it('invokes onOpen when activated', () => {
    const onOpen = mock(() => {});
    render(
      React.createElement(ArtifactCard, {
        artifact: toGalleryArtifact(artifact),
        index: 1,
        onOpen,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: /Open Sales automation ROI/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('ArtifactGallery', () => {
  it('renders provided artifacts as tiles', () => {
    render(React.createElement(ArtifactGallery, { artifacts: [artifact] }));
    expect(screen.getByText('Sales automation ROI')).toBeDefined();
    expect(screen.getByText('1 items')).toBeDefined();
  });

  it('shows the loading state', () => {
    render(React.createElement(ArtifactGallery, { artifacts: [], isLoading: true }));
    expect(screen.getByText('Loading artifacts…')).toBeDefined();
  });

  it('shows the empty state when there are no artifacts', () => {
    render(React.createElement(ArtifactGallery, { artifacts: [] }));
    expect(screen.getByText(/No artifacts yet/)).toBeDefined();
  });

  it('fires onNew from the New button', () => {
    const onNew = mock(() => {});
    render(React.createElement(ArtifactGallery, { artifacts: [], onNew }));
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
