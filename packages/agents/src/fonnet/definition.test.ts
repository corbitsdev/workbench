import { describe, expect, it } from 'bun:test';
import {
  FONNET_CAPABILITIES,
  FONNET_CREDENTIAL_PROVIDER_NAMES,
  FONNET_CREDENTIAL_REQUIREMENTS,
  FONNET_MODEL_CONFIG,
} from './definition';

const researchTools = [
  'firecrawl_search',
  'firecrawl_scrape',
  'granola_search',
  'hackernews_search',
  'github_activity',
  'bluesky_search',
  'scrapecreators_tiktok',
  'write_artifact',
  'mail_search',
  'mail_reply',
  'read_file',
  'write_file',
];

describe('FOnnet definition', () => {
  it('requires one tenant-owned Anthropic LLM credential', () => {
    expect(FONNET_CREDENTIAL_REQUIREMENTS).toHaveLength(1);
    expect(FONNET_CREDENTIAL_REQUIREMENTS[0]).toEqual({
      providerName: 'anthropic',
      source: 'tenant',
      name: 'anthropic-api',
    });
  });

  it('targets Anthropic Sonnet 4.6 through model config', () => {
    expect(FONNET_MODEL_CONFIG).toEqual({
      defaultModel: 'claude-sonnet-4-6',
    });
  });

  it('exposes broad existing research and local artifact tools without mail_send', () => {
    const tools: readonly string[] = FONNET_CAPABILITIES.tools;
    for (const tool of researchTools) {
      expect(tools).toContain(tool);
    }

    expect(FONNET_CAPABILITIES.tools).not.toContain('mail_send');
  });

  it('keeps tool providers in onboarding metadata, not launch credential requirements', () => {
    expect(FONNET_CREDENTIAL_PROVIDER_NAMES).toEqual([
      'firecrawl',
      'granola',
      'github',
      'scrapecreators',
      'bluesky',
    ]);

    const requirementProviders = FONNET_CREDENTIAL_REQUIREMENTS.map((r) => r.providerName);
    expect(requirementProviders).toEqual(['anthropic']);
  });
});
