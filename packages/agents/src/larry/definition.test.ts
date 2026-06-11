import { describe, expect, it } from 'bun:test';
import {
  LARRY_CREDENTIAL_REQUIREMENTS,
  LARRY_CAPABILITIES,
  LARRY_DEPLOY_DESCRIPTOR,
} from './definition';
import { buildLarrySystemPrompt } from './prompt';
import { LARRY_SKILL_CONTENT } from './skill';

describe('LARRY_CREDENTIAL_REQUIREMENTS', () => {
  it('requires an openai-compatible LLM', () => {
    const req = LARRY_CREDENTIAL_REQUIREMENTS.find((r) => r.providerName === 'openai-compatible');
    if (!req) throw new Error('expected openai-compatible credential requirement');
    expect(req.source).toBe('tenant');
  });

  it('requires xai for x_search', () => {
    const req = LARRY_CREDENTIAL_REQUIREMENTS.find((r) => r.providerName === 'xai');
    if (!req) throw new Error('expected xai credential requirement');
    expect(req.source).toBe('tenant');
  });

  it('requires scrapecreators for social scraping', () => {
    const req = LARRY_CREDENTIAL_REQUIREMENTS.find((r) => r.providerName === 'scrapecreators');
    if (!req) throw new Error('expected scrapecreators credential requirement');
    expect(req.source).toBe('tenant');
  });

  it('requires reddit as invoker-scoped credential', () => {
    const req = LARRY_CREDENTIAL_REQUIREMENTS.find((r) => r.providerName === 'reddit');
    if (!req) throw new Error('expected reddit credential requirement');
    expect(req.source).toBe('invoker');
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
