import { describe, expect, it } from 'bun:test';
import { resolveKindLabel } from './resolve-kind-label';

describe('resolveKindLabel', () => {
  it('humanizes kinds', () => {
    expect(resolveKindLabel('founder-pov-post')).toBe('Founder POV Post');
    expect(resolveKindLabel('seo-enrichment')).toBe('SEO Enrichment');
  });

  it('returns undefined for empty values', () => {
    expect(resolveKindLabel(null)).toBeUndefined();
    expect(resolveKindLabel(undefined)).toBeUndefined();
  });
});
