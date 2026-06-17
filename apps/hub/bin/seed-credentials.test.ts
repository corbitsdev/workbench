import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildEntries } from './seed-credentials';

describe('seed-credentials buildEntries', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('includes github entry when GITHUB_API_KEY is set', () => {
    process.env['GITHUB_API_KEY'] = 'ghp_test123';

    const entries = buildEntries();

    const github = entries.find((e) => e.providerName === 'github');
    expect(github).toBeDefined();
    expect(github?.secret).toBe('ghp_test123');
    expect(github?.providerPlugin).toBe('github');
  });

  it('omits github entry when GITHUB_API_KEY is not set', () => {
    delete process.env['GITHUB_API_KEY'];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === 'github')).toBeUndefined();
  });

  it('includes youtube entry when YOUTUBE_API_KEY is set', () => {
    process.env['YOUTUBE_API_KEY'] = 'yt_test123';

    const entries = buildEntries();

    const youtube = entries.find((e) => e.providerName === 'youtube');
    expect(youtube).toBeDefined();
    expect(youtube?.secret).toBe('yt_test123');
    expect(youtube?.providerPlugin).toBe('youtube');
  });

  it('omits youtube entry when YOUTUBE_API_KEY is not set', () => {
    delete process.env['YOUTUBE_API_KEY'];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === 'youtube')).toBeUndefined();
  });

  it('includes anthropic provider metadata when ANTHROPIC_API_KEY is set', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test123';

    const entries = buildEntries();

    const anthropic = entries.find((e) => e.providerName === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic?.secret).toBe('sk-ant-test123');
    expect(anthropic?.providerPlugin).toBe('anthropic');
    expect(anthropic?.credentialName).toBe('anthropic-api');
    expect(anthropic?.metadata).toEqual({ baseURL: 'https://api.anthropic.com' });
  });

  it('includes bluesky entry when both BLUESKY_APP_PASSWORD and BLUESKY_HANDLE are set', () => {
    process.env['BLUESKY_APP_PASSWORD'] = 'xxxx-yyyy-zzzz';
    process.env['BLUESKY_HANDLE'] = 'test.bsky.social';

    const entries = buildEntries();

    const bluesky = entries.find((e) => e.providerName === 'bluesky');
    expect(bluesky).toBeDefined();
    expect(bluesky?.secret).toBe('xxxx-yyyy-zzzz');
    expect(bluesky?.providerPlugin).toBe('bluesky');
    expect(bluesky?.metadata?.['baseURL']).toBe('test.bsky.social');
  });

  it('omits bluesky entry when BLUESKY_APP_PASSWORD is not set', () => {
    delete process.env['BLUESKY_APP_PASSWORD'];
    delete process.env['BLUESKY_HANDLE'];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === 'bluesky')).toBeUndefined();
  });

  it('omits bluesky entry when BLUESKY_APP_PASSWORD is set but BLUESKY_HANDLE is missing', () => {
    process.env['BLUESKY_APP_PASSWORD'] = 'xxxx-yyyy-zzzz';
    delete process.env['BLUESKY_HANDLE'];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === 'bluesky')).toBeUndefined();
  });

  it('includes google-ai entry when GOOGLE_GEMINI_API_KEY is set', () => {
    process.env['GOOGLE_GEMINI_API_KEY'] = 'gem-test-key';

    const entries = buildEntries();

    const google = entries.find((e) => e.credentialName === 'google-ai');
    expect(google).toBeDefined();
    expect(google?.providerName).toBe('google-genai');
    expect(google?.secret).toBe('gem-test-key');
    expect(google?.metadata).toEqual({
      baseURL: 'https://generativelanguage.googleapis.com',
      model: 'gemini-3.1-flash-lite',
    });
  });

  it('accepts GEMINI_API_KEY as an alias for the google-ai entry', () => {
    delete process.env['GOOGLE_GEMINI_API_KEY'];
    process.env['GEMINI_API_KEY'] = 'gem-alias-key';

    const entries = buildEntries();

    const google = entries.find((e) => e.credentialName === 'google-ai');
    expect(google?.secret).toBe('gem-alias-key');
  });

  it('omits google-ai entry when no Gemini key is set', () => {
    delete process.env['GOOGLE_GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];

    const entries = buildEntries();

    expect(entries.find((e) => e.credentialName === 'google-ai')).toBeUndefined();
  });
});
