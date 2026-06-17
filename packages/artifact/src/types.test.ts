/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import type { ArtifactWithVersions } from './types';
import { visualForKind } from './artifact-visuals';

describe('ArtifactWithVersions type export (CL-1552)', () => {
  it('ArtifactWithVersions is exported from @workbench/artifact types', () => {
    const artifact: ArtifactWithVersions = {
      id: 'a-1',
      sessionId: 'wf-1',
      parentId: null,
      painPointId: null,
      kind: 'email',
      title: 'Test',
      content: 'Body',
      status: 'draft',
      version: 1,
      ownerPrincipalId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: [],
    };
    expect(artifact.id).toBe('a-1');
    expect(Array.isArray(artifact.versions)).toBe(true);
  });

  it('ArtifactWithVersions versions array holds ArtifactVersion shape', () => {
    const artifact: ArtifactWithVersions = {
      id: 'a-1',
      sessionId: 'wf-1',
      parentId: null,
      painPointId: null,
      kind: 'email',
      title: 'Test',
      content: 'Body',
      status: 'draft',
      version: 2,
      ownerPrincipalId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: [
        {
          id: 'av-1',
          artifactId: 'a-1',
          version: 1,
          title: 'v1 title',
          content: 'v1 body',
          authorId: 'usr-1',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    expect(artifact.versions).toHaveLength(1);
    expect(artifact.versions[0]!.version).toBe(1);
  });
});

describe('visualForKind sanity (unrelated, ensures test file is valid)', () => {
  it('returns a visual for email', () => {
    const v = visualForKind('email');
    expect(v.label).toBeDefined();
  });
});
