import { describe, expect, it } from 'bun:test';
import { clampTimeoutSeconds, parseBrowserbaseBaseURL, resolveConfig } from './config';

describe('parseBrowserbaseBaseURL', () => {
  it('splits projectId off the query string', () => {
    expect(parseBrowserbaseBaseURL('https://api.browserbase.com/v1?projectId=abc')).toEqual({
      baseUrl: 'https://api.browserbase.com/v1',
      projectId: 'abc',
    });
  });

  it('returns the default base and no projectId when empty', () => {
    expect(parseBrowserbaseBaseURL('')).toEqual({
      baseUrl: 'https://api.browserbase.com/v1',
      projectId: undefined,
    });
  });

  it('throws on an invalid URL', () => {
    expect(() => parseBrowserbaseBaseURL('not a url')).toThrow('valid URL');
  });
});

describe('resolveConfig', () => {
  it('requires an apiKey', () => {
    expect(() => resolveConfig({ apiKey: '', projectId: 'p' })).toThrow('apiKey is required');
  });

  it('fails loud when projectId is missing', () => {
    expect(() => resolveConfig({ apiKey: 'k' })).toThrow('projectId is required');
  });

  it('resolves a valid config and defaults the fetcher to global fetch', () => {
    const resolved = resolveConfig({ apiKey: 'k', projectId: 'p' });
    expect(resolved.baseUrl).toBe('https://api.browserbase.com/v1');
    expect(resolved.projectId).toBe('p');
    expect(resolved.fetcher).toBe(fetch);
    expect(resolved.operationBudgetMs).toBe(18_000);
  });
});

describe('clampTimeoutSeconds', () => {
  it('defaults when not a number', () => {
    expect(clampTimeoutSeconds(undefined)).toBe(180);
  });
  it('clamps below the floor', () => {
    expect(clampTimeoutSeconds(5)).toBe(60);
  });
  it('clamps above the ceiling', () => {
    expect(clampTimeoutSeconds(99999)).toBe(3600);
  });
});
