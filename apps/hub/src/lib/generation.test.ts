import { describe, expect, it } from 'bun:test';
import type { ArtifactKind } from '@workbench/shared';
import { buildRulesBlock, isPublicKind } from './generation';

const PUBLIC_KINDS: ArtifactKind[] = ['linkedin', 'one-pager', 'battlecard'];

describe('isPublicKind', () => {
  it('treats linkedin, one-pager, and battlecard as public', () => {
    for (const kind of PUBLIC_KINDS) {
      expect(isPublicKind(kind)).toBe(true);
    }
  });

  it('treats email as private', () => {
    expect(isPublicKind('email')).toBe(false);
  });
});

describe('buildRulesBlock', () => {
  it('wraps rules, style, and output in XML section tags with a PII rule for every kind', () => {
    for (const kind of [...PUBLIC_KINDS, 'email'] as ArtifactKind[]) {
      const rules = buildRulesBlock(kind);
      expect(rules).toMatch(/<rules>/);
      expect(rules).toMatch(/<style>/);
      expect(rules).toMatch(/<output>/);
      expect(rules).toMatch(/(public|private) artifact/i);
    }
  });

  it('instructs public kinds to strip all customer PII', () => {
    for (const kind of PUBLIC_KINDS) {
      const rules = buildRulesBlock(kind);
      expect(rules).toMatch(/public artifact/i);
      expect(rules).toMatch(/strip and generalise all customer/i);
    }
  });

  it('instructs the private email kind to keep the real customer contact', () => {
    const rules = buildRulesBlock('email');
    expect(rules).toMatch(/private artifact/i);
    expect(rules).toMatch(/keep the real customer contact/i);
  });
});
