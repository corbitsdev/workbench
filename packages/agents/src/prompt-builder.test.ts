import { describe, expect, it } from 'bun:test';
import {
  buildContextBlock,
  buildSystemPrompt,
  formatSection,
  HUMANIZER_SECTION,
} from './prompt-builder';

const xmlFormat = { xml: true };
const markdownFormat = { xml: false };

describe('formatSection', () => {
  it('produces XML tags when xml is enabled', () => {
    const result = formatSection({ tag: 'role', content: 'You are an assistant.' }, xmlFormat);
    expect(result).toBe('<role>\nYou are an assistant.\n</role>');
  });

  it('produces markdown headers when xml is disabled', () => {
    const result = formatSection({ tag: 'role', content: 'You are an assistant.' }, markdownFormat);
    expect(result).toBe('## Role\nYou are an assistant.');
  });

  it('title-cases the tag in markdown headers', () => {
    const result = formatSection({ tag: 'guidelines', content: 'Be concise.' }, markdownFormat);
    expect(result).toBe('## Guidelines\nBe concise.');
  });
});

describe('buildSystemPrompt', () => {
  it('joins sections with double newline for xml', () => {
    const sections = [
      { tag: 'role', content: 'You are an assistant.' },
      { tag: 'guidelines', content: 'Be concise.' },
    ];
    const result = buildSystemPrompt(sections, xmlFormat);
    expect(result).toBe(
      '<role>\nYou are an assistant.\n</role>\n\n<guidelines>\nBe concise.\n</guidelines>'
    );
  });

  it('joins sections with double newline for markdown', () => {
    const sections = [
      { tag: 'role', content: 'You are an assistant.' },
      { tag: 'guidelines', content: 'Be concise.' },
    ];
    const result = buildSystemPrompt(sections, markdownFormat);
    expect(result).toBe('## Role\nYou are an assistant.\n\n## Guidelines\nBe concise.');
  });
});

describe('HUMANIZER_SECTION', () => {
  it('is re-exported from @workbench/prompts', () => {
    expect(HUMANIZER_SECTION.tag).toBe('output');
    expect(HUMANIZER_SECTION.content).toContain('No emojis unless explicitly requested');
  });
});

describe('buildContextBlock', () => {
  it('includes defined keys and skips undefined values for xml', () => {
    const result = buildContextBlock(
      { date: '04/06/2026', 'Human Operator': 'Sawyer', workbench: undefined },
      xmlFormat
    );
    expect(result).toBe('<context>\nDate: 04/06/2026\nHuman Operator: Sawyer\n</context>');
  });

  it('includes defined keys and skips undefined values for markdown', () => {
    const result = buildContextBlock(
      { date: '04/06/2026', 'Human Operator': 'Sawyer', workbench: undefined },
      markdownFormat
    );
    expect(result).toBe('## Context\nDate: 04/06/2026\nHuman Operator: Sawyer');
  });

  it('only includes date when all optional keys are undefined', () => {
    const result = buildContextBlock({ date: '04/06/2026' }, xmlFormat);
    expect(result).toBe('<context>\nDate: 04/06/2026\n</context>');
  });
});
