import { describe, expect, it } from 'bun:test';
import { LLM_CREDENTIAL_NAME } from '../constants';
import { LINCOLN_CREDENTIAL_REQUIREMENTS, LINCOLN_DEPLOY_DESCRIPTOR } from './definition';

describe('lincoln agent definition', () => {
  it('declares only the LLM credential as an inference source requirement', () => {
    expect(LINCOLN_CREDENTIAL_REQUIREMENTS).toHaveLength(1);
    const requirement = LINCOLN_CREDENTIAL_REQUIREMENTS[0];
    expect(requirement?.providerName).toBe('openai-compatible');
    expect(requirement?.source).toBe('tenant');
    expect(requirement?.name).toBe(LLM_CREDENTIAL_NAME);
  });

  it('does not declare the firecrawl tool credential as an inference source', () => {
    const providerNames = LINCOLN_CREDENTIAL_REQUIREMENTS.map((r) => r.providerName);
    expect(providerNames).not.toContain('firecrawl');
  });

  it('still advertises firecrawl as a credential provider for onboarding', () => {
    expect(LINCOLN_DEPLOY_DESCRIPTOR.credentialProviderNames).toEqual([
      'openai-compatible',
      'firecrawl',
    ]);
  });
});
