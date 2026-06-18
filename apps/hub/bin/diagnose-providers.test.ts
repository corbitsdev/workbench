import { describe, expect, it } from 'bun:test';
import { normalizeAnthropicBaseURL } from './diagnose-providers';

describe('normalizeAnthropicBaseURL', () => {
  it('strips a trailing /v1 that doubles the adapter path', () => {
    expect(normalizeAnthropicBaseURL('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com'
    );
  });

  it('strips a trailing /v1 with a trailing slash', () => {
    expect(normalizeAnthropicBaseURL('https://api.anthropic.com/v1/')).toBe(
      'https://api.anthropic.com'
    );
  });

  it('leaves an already-correct bare host unchanged', () => {
    expect(normalizeAnthropicBaseURL('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com'
    );
  });

  it('fills a missing baseURL with the canonical host', () => {
    expect(normalizeAnthropicBaseURL(undefined)).toBe('https://api.anthropic.com');
    expect(normalizeAnthropicBaseURL(null)).toBe('https://api.anthropic.com');
    expect(normalizeAnthropicBaseURL('')).toBe('https://api.anthropic.com');
  });

  it('preserves a custom gateway host while still stripping /v1', () => {
    expect(normalizeAnthropicBaseURL('https://proxy.internal/anthropic/v1')).toBe(
      'https://proxy.internal/anthropic'
    );
  });
});
