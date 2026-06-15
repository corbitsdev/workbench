import { describe, expect, it } from 'bun:test';
import type { ArtifactKind } from '@workbench/shared';
import { buildRulesBlock, isPublicKind, tryParseCollateral } from './generation';

const PUBLIC_KINDS: ArtifactKind[] = [
  'linkedin-post',
  'twitter-post',
  'blog',
  'founder-pov-post',
  'one-pager',
  'case-study',
  'objection-handling',
  'customer-quotes',
  'battlecard',
];

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
      expect(rules).toMatch(/<output[\s>]/);
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

describe('tryParseCollateral', () => {
  it('strips leaked <item> wrapper tags from a customer-quotes body', () => {
    const body = [
      '<item>',
      'Quote: "Onboarding used to take us three weeks."',
      'Attribution: VP of Engineering, mid-market SaaS',
      'Context: Discussing the legacy migration process',
      'Theme: Time to value',
      '</item>',
      '<item>',
      'Quote: "We cut that to two days."',
      'Attribution: Same VP, later in the call',
      'Context: After adopting the new workflow',
      'Theme: Efficiency',
      '</item>',
    ].join('\n');
    const raw = JSON.stringify({ title: 'Customer Quotes', body });

    const result = tryParseCollateral(raw, 'wf_1', 'customer-quotes');

    expect(result.body).not.toContain('<item>');
    expect(result.body).not.toContain('</item>');
    expect(result.body).toContain('Quote: "Onboarding used to take us three weeks."');
    expect(result.body).toContain('Attribution: VP of Engineering, mid-market SaaS');
    expect(result.body).toContain('Context: Discussing the legacy migration process');
    expect(result.body).toContain('Theme: Time to value');
    expect(result.body).toContain('Quote: "We cut that to two days."');
  });

  it('strips self-closing <item/> tags', () => {
    const raw = JSON.stringify({ title: 'T', body: 'before<item/>after' });

    const result = tryParseCollateral(raw, 'wf_1', 'customer-quotes');

    expect(result.body).not.toContain('<item');
    expect(result.body).toContain('before');
    expect(result.body).toContain('after');
  });

  it('strips broadened scaffolding tags (e.g. <field>) via the domain sanitizer', () => {
    const body = '<field name="body">\nThe real content.\n</field>';
    const raw = JSON.stringify({ title: 'T', body });

    const result = tryParseCollateral(raw, 'wf_1', 'customer-quotes');

    expect(result.body).not.toContain('<field');
    expect(result.body).not.toContain('</field>');
    expect(result.body).toContain('The real content.');
  });

  it('returns a body with no structural tags unchanged', () => {
    const body = '## Heading\n\nA normal paragraph with <strong>emphasis</strong> and a list.\n\n- one\n- two';
    const raw = JSON.stringify({ title: 'Blog', body });

    const result = tryParseCollateral(raw, 'wf_1', 'blog');

    expect(result.body).toBe(body);
  });
});
