import { describe, expect, it } from 'bun:test';
import { resolveCorsAllowOrigin } from './cors-origin';

describe('resolveCorsAllowOrigin', () => {
  const allowed = ['https://app.example.com', 'https://admin.example.com'];

  it('returns the request origin when it is in the allowlist', () => {
    expect(resolveCorsAllowOrigin('https://app.example.com', allowed)).toBe(
      'https://app.example.com'
    );
  });

  it('returns undefined for an origin not in the allowlist (no fallback)', () => {
    expect(resolveCorsAllowOrigin('https://evil.example.com', allowed)).toBeUndefined();
  });

  it('returns undefined when no origin header is present', () => {
    expect(resolveCorsAllowOrigin(null, allowed)).toBeUndefined();
    expect(resolveCorsAllowOrigin(undefined, allowed)).toBeUndefined();
    expect(resolveCorsAllowOrigin('', allowed)).toBeUndefined();
  });

  it('returns undefined when the allowlist is empty', () => {
    expect(resolveCorsAllowOrigin('https://app.example.com', [])).toBeUndefined();
  });
});
