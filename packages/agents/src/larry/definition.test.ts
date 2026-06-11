import { describe, expect, it } from 'bun:test';
import {
  LARRY_CREDENTIAL_REQUIREMENTS,
  LARRY_CAPABILITIES,
  LARRY_DEPLOY_DESCRIPTOR,
} from './definition';
import { buildLarrySystemPrompt } from './prompt';
import { LARRY_SKILL_CONTENT } from './skill';

describe('LARRY_CREDENTIAL_REQUIREMENTS', () => {
  it('has exactly one entry', () => {
    expect(LARRY_CREDENTIAL_REQUIREMENTS).toHaveLength(1);
  });

  it('requires an openai-compatible LLM', () => {
    const req = LARRY_CREDENTIAL_REQUIREMENTS[0];
    if (!req) throw new Error('expected at least one credential requirement');
    expect(req.providerName).toBe('openai-compatible');
    expect(req.source).toBe('tenant');
  });
});

describe('buildLarrySystemPrompt', () => {
  it('contains LARRY_SKILL_CONTENT verbatim', () => {
    const prompt = buildLarrySystemPrompt('Larry');
    expect(prompt).toContain(LARRY_SKILL_CONTENT);
  });

  it('includes the agent name', () => {
    const prompt = buildLarrySystemPrompt('TestLarry');
    expect(prompt).toContain('TestLarry');
  });
});

describe('LARRY_CAPABILITIES tools', () => {
  it('all tool names are non-empty strings', () => {
    for (const tool of LARRY_CAPABILITIES.tools) {
      expect(typeof tool).toBe('string');
      expect(tool.length).toBeGreaterThan(0);
    }
  });

  it('requiredTools is a subset of defaultTools', () => {
    const defaultSet = new Set(LARRY_DEPLOY_DESCRIPTOR.defaultTools);
    for (const tool of LARRY_DEPLOY_DESCRIPTOR.requiredTools) {
      expect(defaultSet.has(tool)).toBe(true);
    }
  });
});
