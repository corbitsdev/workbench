import { describe, expect, it } from 'bun:test';
import {
  FOPUS_CAPABILITIES,
  FOPUS_CREDENTIAL_PROVIDER_NAMES,
  FOPUS_CREDENTIAL_REQUIREMENTS,
  FOPUS_MODEL_CONFIG,
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

describe('FOPus definition', () => {
  it('requires one tenant-owned Anthropic LLM credential', () => {
    expect(FOPUS_CREDENTIAL_REQUIREMENTS).toHaveLength(1);
    expect(FOPUS_CREDENTIAL_REQUIREMENTS[0]).toEqual({
      providerName: 'anthropic',
      source: 'tenant',
      name: 'anthropic-api',
    });
  });

  it('targets Anthropic Opus 4.8 through model config', () => {
    expect(FOPUS_MODEL_CONFIG).toEqual({
      defaultModel: 'claude-opus-4-8',
    });
  });

  it('exposes broad existing research and local artifact tools without mail_send', () => {
    const tools: readonly string[] = FOPUS_CAPABILITIES.tools;
    for (const tool of researchTools) {
      expect(tools).toContain(tool);
    }

    expect(FOPUS_CAPABILITIES.tools).not.toContain('mail_send');
  });

  it('keeps tool providers in onboarding metadata, not launch credential requirements', () => {
    expect(FOPUS_CREDENTIAL_PROVIDER_NAMES).toEqual([
      'firecrawl',
      'granola',
      'github',
      'scrapecreators',
      'bluesky',
    ]);

    const requirementProviders = FOPUS_CREDENTIAL_REQUIREMENTS.map((r) => r.providerName);
    expect(requirementProviders).toEqual(['anthropic']);
  });
});
