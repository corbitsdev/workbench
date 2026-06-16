import { describe, expect, it } from 'bun:test';
import { collateralTypeOptions } from '@workbench/gtm-workflows';
import { resolveKindLabel } from './resolve-kind-label';

describe('resolveKindLabel', () => {
  it('returns the curated label for known collateral kinds', () => {
    const option = collateralTypeOptions[0];
    if (!option) throw new Error('Expected at least one collateral type option');
    expect(resolveKindLabel(option.id)).toBe(option.label);
  });

  it('humanizes unknown kinds', () => {
    expect(resolveKindLabel('founder-pov-post')).toBe('Founder POV Post');
  });

  it('returns undefined for empty values', () => {
    expect(resolveKindLabel(null)).toBeUndefined();
    expect(resolveKindLabel(undefined)).toBeUndefined();
  });
});
