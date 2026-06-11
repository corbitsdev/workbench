import { describe, expect, it } from 'bun:test';
import { buildPersonalAgentSystemPrompt } from './prompt';

const xmlFormat = { xml: true };
const markdownFormat = { xml: false };

describe('buildPersonalAgentSystemPrompt', () => {
  it('frames the named agent as a Chief of Staff loyal to one operator', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('Myra is a Chief of Staff and Executive Assistant');
    expect(prompt).toContain('single human operator');
  });

  it('interpolates whatever name is supplied', () => {
    const prompt = buildPersonalAgentSystemPrompt('Assistant', xmlFormat);
    expect(prompt).toContain('Assistant is a Chief of Staff');
  });

  it('includes the role, capabilities, and guidelines sections', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<role>');
    expect(prompt).toContain('<capabilities>');
    expect(prompt).toContain('<guidelines>');
  });

  it('describes runtime discovery and delegation to specialist agents', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('discover them at runtime');
    expect(prompt).toContain('delegate');
  });

  it('includes a dedicated delegation section', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<delegation>');
  });

  it('coordinates expertise rather than claiming authority', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('coordinate expertise');
  });

  it('directs the agent to confirm before irreversible or high-stakes actions', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt.toLowerCase()).toContain('irreversible');
  });

  it('forbids fabrication and impersonation of the operator', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('Never fabricate information');
    expect(prompt).toContain('Never impersonate the operator');
  });

  it('carries a concise style note rather than the full humanizer essay', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('No emojis unless explicitly requested');
    expect(prompt).not.toContain('superficial -ing analyses');
    expect(prompt).not.toContain('negative parallelisms');
  });

  it('respects the requested output format', () => {
    expect(buildPersonalAgentSystemPrompt('Myra', xmlFormat)).toContain('<role>');
    expect(buildPersonalAgentSystemPrompt('Myra', markdownFormat)).toContain('## Role');
  });
});
