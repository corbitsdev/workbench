import { describe, expect, it } from 'bun:test';
import { buildLoopAgentSystemPrompt } from './prompt';

const xmlFormat = { xml: true };
const markdownFormat = { xml: false };

describe('buildLoopAgentSystemPrompt', () => {
  it('frames the named agent as a research and intelligence agent', () => {
    const prompt = buildLoopAgentSystemPrompt('Loop', xmlFormat);
    expect(prompt).toContain('Loop is a research and intelligence agent');
  });

  it('interpolates whatever name is supplied', () => {
    const prompt = buildLoopAgentSystemPrompt('Scout', xmlFormat);
    expect(prompt).toContain('Scout is a research and intelligence agent');
  });

  it('includes the role, capabilities, and guidelines sections', () => {
    const prompt = buildLoopAgentSystemPrompt('Loop', xmlFormat);
    expect(prompt).toContain('<role>');
    expect(prompt).toContain('<capabilities>');
    expect(prompt).toContain('<guidelines>');
  });

  it('describes synthesis and maintaining running context', () => {
    const prompt = buildLoopAgentSystemPrompt('Loop', xmlFormat);
    expect(prompt).toContain('synthesise');
    expect(prompt).toContain('running thread of context');
  });

  it('distinguishes observed from inferred and forbids fabricated citations', () => {
    const prompt = buildLoopAgentSystemPrompt('Loop', xmlFormat);
    expect(prompt).toContain('observed vs. what is inferred');
    expect(prompt).toContain('Never fabricate quotes, names, or citations');
  });

  it('appends the shared humanizer output section', () => {
    const prompt = buildLoopAgentSystemPrompt('Loop', xmlFormat);
    expect(prompt).toContain('No emojis unless explicitly requested');
  });

  it('respects the requested output format', () => {
    expect(buildLoopAgentSystemPrompt('Loop', xmlFormat)).toContain('<role>');
    expect(buildLoopAgentSystemPrompt('Loop', markdownFormat)).toContain('## Role');
  });
});
