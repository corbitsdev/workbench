/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { isLinkedInPostArtifactKind, usesSocialPostPreview } from './artifact-kinds';

describe('isLinkedInPostArtifactKind', () => {
  it('returns true for linkedin-post and legacy linkedin kinds', () => {
    expect(isLinkedInPostArtifactKind('linkedin-post')).toBe(true);
    expect(isLinkedInPostArtifactKind('linkedin-daily')).toBe(true);
    expect(isLinkedInPostArtifactKind('linkedin')).toBe(true);
    expect(isLinkedInPostArtifactKind('pain-points-linkedin-post')).toBe(true);
  });

  it('returns false for non-linkedin artifact kinds', () => {
    expect(isLinkedInPostArtifactKind('email')).toBe(false);
    expect(isLinkedInPostArtifactKind('twitter-post')).toBe(false);
    expect(isLinkedInPostArtifactKind('pain-points-twitter-post')).toBe(false);
    expect(isLinkedInPostArtifactKind('founder-pov-post')).toBe(false);
  });
});

describe('usesSocialPostPreview', () => {
  it('returns true for linkedin and twitter-style social post kinds', () => {
    expect(usesSocialPostPreview('linkedin-post')).toBe(true);
    expect(usesSocialPostPreview('linkedin-daily')).toBe(true);
    expect(usesSocialPostPreview('twitter-post')).toBe(true);
    expect(usesSocialPostPreview('pain-points-twitter-post')).toBe(true);
    expect(usesSocialPostPreview('founder-pov-post')).toBe(true);
  });

  it('returns false for non-social artifact kinds', () => {
    expect(usesSocialPostPreview('email')).toBe(false);
    expect(usesSocialPostPreview('blog')).toBe(false);
  });
});
