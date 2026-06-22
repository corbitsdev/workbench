import { describe, expect, it } from 'bun:test';
import {
  ANTHROPIC_AB_COMPARISON_MODELS,
  GOOGLE_GENAI_AB_COMPARISON_MODELS,
  NEAR_AI_MODELS,
  OPENAI_AB_COMPARISON_MODELS,
  OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS,
  defaultAbComparisonModel,
  isAbComparisonModelAllowed,
  listAbComparisonModels,
  validateAbComparisonProviders,
} from './models';

describe('blind A/B comparison model catalog', () => {
  it('lists current Anthropic API models', () => {
    expect(ANTHROPIC_AB_COMPARISON_MODELS).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
  });

  it('lists OpenCode Zen chat/completions models and excludes other endpoints', () => {
    expect(OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS).toEqual([
      'kimi-k2.6',
      'glm-5.1',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'kimi-k2.5',
      'minimax-m2.7',
      'minimax-m2.5',
      'grok-build-0.1',
      'big-pickle',
      'glm-5',
    ]);
    expect(OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS).not.toContain('deepseek-v4-flash-free');
    expect(OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS).not.toContain('gpt-5.4-mini');
    expect(OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS).not.toContain('claude-sonnet-4-6');
  });

  it('lists current OpenAI frontier models', () => {
    expect(OPENAI_AB_COMPARISON_MODELS).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
    expect(OPENAI_AB_COMPARISON_MODELS).not.toContain('gpt-4o');
  });

  it('lists current Google Gemini text models', () => {
    expect(GOOGLE_GENAI_AB_COMPARISON_MODELS).toEqual([
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite',
    ]);
    expect(GOOGLE_GENAI_AB_COMPARISON_MODELS).not.toContain('gemini-2.5-flash');
  });

  it('lists Near AI models', () => {
    expect(NEAR_AI_MODELS).toEqual(['deepseek-ai/DeepSeek-V4-Flash']);
  });

  it('defaults to the first catalog model per plugin', () => {
    expect(defaultAbComparisonModel('anthropic', 'anthropic')).toBe('claude-opus-4-8');
    expect(defaultAbComparisonModel('opencode-zen', 'openai-compatible')).toBe('kimi-k2.6');
    expect(defaultAbComparisonModel('openai', 'openai')).toBe('gpt-5.5');
    expect(defaultAbComparisonModel('google-genai', 'google-genai')).toBe('gemini-3.5-flash');
  });

  it('defaults to the near-ai model list when providerName is near-ai', () => {
    expect(defaultAbComparisonModel('near-ai', 'openai-compatible')).toBe('deepseek-ai/DeepSeek-V4-Flash');
    expect(listAbComparisonModels('near-ai', 'openai-compatible')).toEqual(['deepseek-ai/DeepSeek-V4-Flash']);
  });

  it('rejects provider metadata models that are not in the catalog', () => {
    expect(isAbComparisonModelAllowed('opencode-zen', 'openai-compatible', 'gpt-4o')).toBe(false);
    expect(isAbComparisonModelAllowed('opencode-zen', 'openai-compatible', 'deepseek-v4-flash')).toBe(true);
    expect(isAbComparisonModelAllowed('anthropic', 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(isAbComparisonModelAllowed('anthropic', 'anthropic', 'claude-haiku-4-6')).toBe(false);
    expect(isAbComparisonModelAllowed('near-ai', 'openai-compatible', 'kimi-k2.6')).toBe(false);
    expect(isAbComparisonModelAllowed('near-ai', 'openai-compatible', 'deepseek-ai/DeepSeek-V4-Flash')).toBe(true);
  });

  it('validateAbComparisonProviders requires two entries with allowed models', () => {
    expect(
      validateAbComparisonProviders([
        { providerName: 'anthropic', providerPlugin: 'anthropic', model: 'claude-sonnet-4-6' },
        { providerName: 'opencode-zen', providerPlugin: 'openai-compatible', model: 'deepseek-v4-flash' },
      ])
    ).toEqual({ valid: true });

    expect(
      validateAbComparisonProviders([
        { providerName: 'opencode-zen', providerPlugin: 'openai-compatible', model: 'gpt-4o' },
        { providerName: 'anthropic', providerPlugin: 'anthropic', model: 'claude-haiku-4-5' },
      ])
    ).toEqual({ valid: false, error: 'Model gpt-4o is not allowed for opencode-zen' });

    expect(
      validateAbComparisonProviders([
        { providerName: 'near-ai', providerPlugin: 'openai-compatible', model: 'deepseek-ai/DeepSeek-V4-Flash' },
        { providerName: 'anthropic', providerPlugin: 'anthropic', model: 'claude-sonnet-4-6' },
      ])
    ).toEqual({ valid: true });
  });
});