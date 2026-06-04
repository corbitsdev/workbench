import { describe, expect, it } from 'bun:test';
import type { ArtifactWithSession } from '@workbench/shared';
import { toGalleryArtifact, visualForKind } from './artifact-visuals';

describe('visualForKind', () => {
  it('maps known kinds to their visuals', () => {
    expect(visualForKind('email').label).toBe('Email');
    expect(visualForKind('battlecard').viz).toBe('grid');
  });

  it('falls back to a neutral document tile for unknown kinds', () => {
    const v = visualForKind('totally-unknown-kind');
    expect(v.label).toBe('Document');
    expect(v.fill).toBe('bg-cream');
  });
});

describe('toGalleryArtifact', () => {
  const base: ArtifactWithSession = {
    id: 'a-1',
    sessionId: 'wf-1',
    parentId: null,
    painPointId: 'p-1',
    kind: 'email',
    title: 'Title',
    content: 'body',
    status: 'approved',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionName: 'Acme Corp',
    sessionStatus: 'done',
  };

  it('uses session name as the from label', () => {
    expect(toGalleryArtifact(base).from).toBe('Acme Corp');
  });

  it('falls back to a placeholder when session name is null', () => {
    expect(toGalleryArtifact({ ...base, sessionName: null }).from).toBe('Untitled session');
  });

  it('returns empty time string for an unparseable timestamp (NaN guard)', () => {
    expect(toGalleryArtifact({ ...base, updatedAt: 'not-a-date' }).time).toBe('');
  });
});
