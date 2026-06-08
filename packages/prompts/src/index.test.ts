import { describe, expect, it } from 'bun:test';
import {
  buildContextBlock,
  buildStructuredSystemPrompt,
  buildSystemPrompt,
  formatSection,
  HUMANIZER_SECTION,
  jsonOutputContract,
  structuredSection,
  xml,
} from './index';

const xmlFormat = { xml: true };
const markdownFormat = { xml: false };

describe('HUMANIZER_SECTION', () => {
  it('has the output tag and no-emoji rule', () => {
    expect(HUMANIZER_SECTION.tag).toBe('output');
    expect(HUMANIZER_SECTION.content).toContain('No emojis unless explicitly requested');
  });
});

describe('prompt format helpers', () => {
  it('uses an explicit boolean format toggle', () => {
    expect(formatSection({ tag: 'role', content: 'You are an assistant.' }, xmlFormat)).toBe(
      '<role>\nYou are an assistant.\n</role>'
    );
    expect(buildSystemPrompt([{ tag: 'role', content: 'Be useful.' }], markdownFormat)).toBe(
      '## Role\nBe useful.'
    );
    expect(buildContextBlock({ date: '04/06/2026', workbench: undefined }, xmlFormat)).toBe(
      '<context>\nDate: 04/06/2026\n</context>'
    );
  });
});

describe('structured XML prompts', () => {
  it('renders attrs, nested sections, and JSON output contracts', () => {
    const prompt = buildStructuredSystemPrompt([
      structuredSection('role', 'Write collateral'),
      structuredSection('rules', [xml('item', 'No PII')]),
      structuredSection('contract', jsonOutputContract({ title: 'Artifact title' })),
    ]);

    expect(prompt).toContain('<role>\nWrite collateral\n</role>');
    expect(prompt).toContain('<item>\nNo PII\n</item>');
    expect(prompt).toContain('<output format="json" fences="false">');
    expect(prompt).toContain('<field name="title">\nArtifact title\n</field>');
  });
});
