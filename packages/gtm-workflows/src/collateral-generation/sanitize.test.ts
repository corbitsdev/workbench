import { describe, expect, it } from 'bun:test';
import { stripLeakedPromptTags } from './sanitize';

describe('stripLeakedPromptTags', () => {
  it('removes leaked <item> wrapper tags from a customer-quotes body, keeping inner lines', () => {
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

    const result = stripLeakedPromptTags(body);

    expect(result).not.toContain('<item>');
    expect(result).not.toContain('</item>');
    expect(result).toContain('Quote: "Onboarding used to take us three weeks."');
    expect(result).toContain('Attribution: VP of Engineering, mid-market SaaS');
    expect(result).toContain('Context: Discussing the legacy migration process');
    expect(result).toContain('Theme: Time to value');
    expect(result).toContain('Quote: "We cut that to two days."');
    expect(result).not.toMatch(/\n{3,}/);
  });

  it('removes self-closing <item/> tags', () => {
    const result = stripLeakedPromptTags('before<item/>after');

    expect(result).not.toContain('<item');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('removes other scaffolding tags including attributed <field name="body">', () => {
    const body = [
      '<output format="json">',
      '<field name="body">',
      'The real content.',
      '</field>',
      '</output>',
    ].join('\n');

    const result = stripLeakedPromptTags(body);

    expect(result).not.toContain('<output');
    expect(result).not.toContain('<field');
    expect(result).not.toContain('</field>');
    expect(result).not.toContain('</output>');
    expect(result).toContain('The real content.');
  });

  it('removes a section tag such as <structure> while preserving content', () => {
    const result = stripLeakedPromptTags('<structure>\nA point.\n</structure>');

    expect(result).not.toContain('<structure>');
    expect(result).toContain('A point.');
  });

  it('leaves fenced code blocks with trailing spaces and intentional blank lines untouched', () => {
    const body = ['```ts', 'const x = 1;   ', '', '', 'const y = 2;', '```'].join('\n');

    const result = stripLeakedPromptTags(body);

    expect(result).toBe(body);
  });

  it('leaves legitimate non-scaffolding tags such as <strong> unchanged', () => {
    const body = '## Heading\n\nA paragraph with <strong>emphasis</strong>.\n\n- one\n- two';

    const result = stripLeakedPromptTags(body);

    expect(result).toBe(body);
  });
});
