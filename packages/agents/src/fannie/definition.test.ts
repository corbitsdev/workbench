import { describe, expect, it } from 'bun:test';
import {
  FANNIE_CAPABILITIES,
  FANNIE_CREDENTIAL_PROVIDER_NAMES,
  FANNIE_CREDENTIAL_REQUIREMENTS,
  FANNIE_MODEL_CONFIG,
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

describe('Fannie definition', () => {
  it('requires one tenant-owned Anthropic LLM credential', () => {
    expect(FANNIE_CREDENTIAL_REQUIREMENTS).toHaveLength(1);
    expect(FANNIE_CREDENTIAL_REQUIREMENTS[0]).toEqual({
      providerName: 'anthropic',
      source: 'tenant',
      name: 'anthropic-api',
    });
  });

  it('targets Anthropic Sonnet 4.6 through model config', () => {
    expect(FANNIE_MODEL_CONFIG).toEqual({
      defaultModel: 'claude-sonnet-4-6',
    });
  });

  it('exposes broad existing research and local artifact tools without mail_send', () => {
    const tools: readonly string[] = FANNIE_CAPABILITIES.tools;
    for (const tool of researchTools) {
      expect(tools).toContain(tool);
    }

    expect(FANNIE_CAPABILITIES.tools).not.toContain('mail_send');
  });

  it('keeps tool providers in onboarding metadata, not launch credential requirements', () => {
    expect(FANNIE_CREDENTIAL_PROVIDER_NAMES).toEqual([
      'firecrawl',
      'granola',
      'github',
      'scrapecreators',
      'bluesky',
    ]);

    const requirementProviders = FANNIE_CREDENTIAL_REQUIREMENTS.map((r) => r.providerName);
    expect(requirementProviders).toEqual(['anthropic']);
  });
});
