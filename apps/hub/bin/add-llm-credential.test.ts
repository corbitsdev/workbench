import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { detectGoogleAi, detectProvider } from './add-llm-credential';

describe('add-llm-credential detectProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['LLM_PROVIDER_NAME'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_COMPATIBLE_API_KEY'];
    delete process.env['LLM_API_KEY'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('sets the anthropic baseURL so the provider is configured regardless of run order', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test123';

    const detected = detectProvider();

    expect(detected.providerName).toBe('anthropic');
    expect(detected.baseURL).toBe('https://api.anthropic.com');
    expect(detected.credentialName).toBe('anthropic-api');
  });

  it('sets the anthropic baseURL when selected explicitly via LLM_PROVIDER_NAME', () => {
    process.env['LLM_PROVIDER_NAME'] = 'anthropic';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test123';

    const detected = detectProvider();

    expect(detected.providerName).toBe('anthropic');
    expect(detected.baseURL).toBe('https://api.anthropic.com');
  });

  it('does not set a baseURL for the first-party openai provider', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai-test';

    const detected = detectProvider();

    expect(detected.providerName).toBe('openai');
    expect(detected.baseURL).toBeUndefined();
  });

  it('falls back to openai-compatible with a baseURL when no first-party key is set', () => {
    process.env['OPENAI_COMPATIBLE_API_KEY'] = 'sk-compat-test';
    process.env['OPENAI_COMPATIBLE_BASE_URL'] = 'https://llm.example.com/v1';

    const detected = detectProvider();

    expect(detected.providerName).toBe('openai-compatible');
    expect(detected.baseURL).toBe('https://llm.example.com/v1');
  });
});

describe('add-llm-credential detectGoogleAi', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['GOOGLE_GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_AI_CREDENTIAL_NAME'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns google-genai config when GOOGLE_GEMINI_API_KEY is set', () => {
    process.env['GOOGLE_GEMINI_API_KEY'] = 'gem-test';

    const detected = detectGoogleAi();

    expect(detected).toEqual({
      providerName: 'google-genai',
      apiKey: 'gem-test',
      baseURL: 'https://generativelanguage.googleapis.com',
      credentialName: 'google-ai',
    });
  });

  it('accepts GEMINI_API_KEY as an alias', () => {
    process.env['GEMINI_API_KEY'] = 'gem-alias';

    expect(detectGoogleAi()?.apiKey).toBe('gem-alias');
  });

  it('returns null when no Gemini key is configured', () => {
    expect(detectGoogleAi()).toBeNull();
  });
});
