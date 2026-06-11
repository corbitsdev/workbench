import { describe, expect, it } from 'bun:test';
import { buildGranolaSystemPrompt } from './prompt';

const xmlFormat = { xml: true };
const markdownFormat = { xml: false };

describe('buildGranolaSystemPrompt', () => {
  it('declares the named agent in the role section', () => {
    const prompt = buildGranolaSystemPrompt('Freddy', xmlFormat);
    expect(prompt).toContain('Freddy is a call intelligence agent');
  });

  it('interpolates whatever name is supplied', () => {
    const prompt = buildGranolaSystemPrompt('Custom Name', xmlFormat);
    expect(prompt).toContain('Custom Name is a call intelligence agent');
  });

  it('includes the four core contract sections', () => {
    const prompt = buildGranolaSystemPrompt('Freddy', xmlFormat);
    expect(prompt).toContain('<role>');
    expect(prompt).toContain('<capabilities>');
    expect(prompt).toContain('<call_document_schema>');
    expect(prompt).toContain('<guidelines>');
  });

  it('specifies the fixed call-document schema with its required sections', () => {
    const prompt = buildGranolaSystemPrompt('Freddy', xmlFormat);
    expect(prompt).toContain('# Call: {title}');
    expect(prompt).toContain('## Summary');
    expect(prompt).toContain('## Pain Points');
    expect(prompt).toContain('## Key Statistics');
    expect(prompt).toContain('## Notes');
  });

  it('requires grounding tool calls before answering and forbids fabrication', () => {
    const prompt = buildGranolaSystemPrompt('Freddy', xmlFormat);
    expect(prompt).toContain('granola_list_notes');
    expect(prompt).toContain('granola_get_note');
    expect(prompt).toContain('Never generate, invent, or guess call data');
  });

  it('instructs the agent not to initiate contact', () => {
    const prompt = buildGranolaSystemPrompt('Freddy', xmlFormat);
    expect(prompt).toContain('You do not initiate contact');
  });

  it('appends the shared humanizer output section', () => {
    const prompt = buildGranolaSystemPrompt('Freddy', xmlFormat);
    expect(prompt).toContain('No emojis unless explicitly requested');
  });

  it('renders sections as XML tags under the xml format', () => {
    const prompt = buildGranolaSystemPrompt('Freddy', xmlFormat);
    expect(prompt).toContain('<role>');
    expect(prompt).not.toContain('## Role');
  });

  it('renders sections as markdown headings under the non-xml format', () => {
    const prompt = buildGranolaSystemPrompt('Freddy', markdownFormat);
    expect(prompt).toContain('## Role');
    expect(prompt).not.toContain('<role>');
  });
});
