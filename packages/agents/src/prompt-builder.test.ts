import { describe, expect, it } from 'bun:test';
import {
  formatFromModel,
  formatSection,
  buildSystemPrompt,
  buildContextBlock,
} from './prompt-builder';

describe('formatFromModel', () => {
  it('returns xml for claude-sonnet-4-6', () => {
    expect(formatFromModel('claude-sonnet-4-6')).toBe('xml');
  });

  it('returns markdown for gpt-4o', () => {
    expect(formatFromModel('gpt-4o')).toBe('markdown');
  });

  it('returns xml for claude-haiku-4-5', () => {
    expect(formatFromModel('claude-haiku-4-5')).toBe('xml');
  });
});

describe('formatSection', () => {
  it('produces XML tags for xml format', () => {
    const result = formatSection({ tag: 'role', content: 'You are an assistant.' }, 'xml');
    expect(result).toBe('<role>\nYou are an assistant.\n</role>');
  });

  it('produces markdown headers for markdown format', () => {
    const result = formatSection({ tag: 'role', content: 'You are an assistant.' }, 'markdown');
    expect(result).toBe('## Role\nYou are an assistant.');
  });

  it('title-cases the tag in markdown headers', () => {
    const result = formatSection({ tag: 'guidelines', content: 'Be concise.' }, 'markdown');
    expect(result).toBe('## Guidelines\nBe concise.');
  });
});

describe('buildSystemPrompt', () => {
  it('joins sections with double newline for xml', () => {
    const sections = [
      { tag: 'role', content: 'You are an assistant.' },
      { tag: 'guidelines', content: 'Be concise.' },
    ];
    const result = buildSystemPrompt(sections, 'xml');
    expect(result).toBe(
      '<role>\nYou are an assistant.\n</role>\n\n<guidelines>\nBe concise.\n</guidelines>'
    );
  });

  it('joins sections with double newline for markdown', () => {
    const sections = [
      { tag: 'role', content: 'You are an assistant.' },
      { tag: 'guidelines', content: 'Be concise.' },
    ];
    const result = buildSystemPrompt(sections, 'markdown');
    expect(result).toBe('## Role\nYou are an assistant.\n\n## Guidelines\nBe concise.');
  });
});

describe('buildContextBlock', () => {
  it('includes defined keys and skips undefined values for xml', () => {
    const result = buildContextBlock(
      { date: '04/06/2026', 'Human Operator': 'Sawyer', workspace: undefined },
      'xml'
    );
    expect(result).toBe('<context>\nDate: 04/06/2026\nHuman Operator: Sawyer\n</context>');
  });

  it('includes defined keys and skips undefined values for markdown', () => {
    const result = buildContextBlock(
      { date: '04/06/2026', 'Human Operator': 'Sawyer', workspace: undefined },
      'markdown'
    );
    expect(result).toBe('## Context\nDate: 04/06/2026\nHuman Operator: Sawyer');
  });

  it('only includes date when all optional keys are undefined', () => {
    const result = buildContextBlock({ date: '04/06/2026' }, 'xml');
    expect(result).toBe('<context>\nDate: 04/06/2026\n</context>');
  });
});
