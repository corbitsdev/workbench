import { describe, expect, it } from 'bun:test';
import {
  FREDDIE_CAPABILITIES,
  FREDDIE_CREDENTIAL_PROVIDER_NAMES,
  FREDDIE_CREDENTIAL_REQUIREMENTS,
  FREDDIE_DEPLOY_DESCRIPTOR,
  FREDDIE_DEPLOY_PROMPT,
  FREDDIE_MODEL_CONFIG,
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

describe('Freddie definition', () => {
  it('requires one tenant-owned Anthropic LLM credential', () => {
    expect(FREDDIE_CREDENTIAL_REQUIREMENTS).toHaveLength(1);
    expect(FREDDIE_CREDENTIAL_REQUIREMENTS[0]).toEqual({
      providerName: 'anthropic',
      source: 'tenant',
      name: 'anthropic-api',
    });
  });

  it('targets Anthropic Opus 4.8 through model config', () => {
    expect(FREDDIE_MODEL_CONFIG).toEqual({
      defaultModel: 'claude-opus-4-8',
    });
  });

  it('exposes broad existing research and local artifact tools without mail_send', () => {
    const tools: readonly string[] = FREDDIE_CAPABILITIES.tools;
    for (const tool of researchTools) {
      expect(tools).toContain(tool);
    }

    expect(FREDDIE_CAPABILITIES.tools).not.toContain('mail_send');
  });

  it('appends Workbench mail-vs-chat guidance onto the base prompt', () => {
    expect(FREDDIE_DEPLOY_PROMPT).toContain('# Claude Fable 5');
    expect(FREDDIE_DEPLOY_PROMPT).toContain('Workbench operating context');
    expect(FREDDIE_DEPLOY_PROMPT).toContain('Do not call a mail tool to answer the user');
    expect(FREDDIE_DEPLOY_PROMPT).toContain('never pass `uid: 0`');
    expect(FREDDIE_DEPLOY_DESCRIPTOR.systemPrompt).toBe(FREDDIE_DEPLOY_PROMPT);
  });

  it('keeps tool providers in onboarding metadata, not launch credential requirements', () => {
    expect(FREDDIE_CREDENTIAL_PROVIDER_NAMES).toEqual([
      'firecrawl',
      'granola',
      'github',
      'scrapecreators',
      'bluesky',
    ]);

    const requirementProviders = FREDDIE_CREDENTIAL_REQUIREMENTS.map((r) => r.providerName);
    expect(requirementProviders).toEqual(['anthropic']);
  });
});
