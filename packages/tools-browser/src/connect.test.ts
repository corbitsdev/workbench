import { describe, expect, it } from 'bun:test';
import { getPage, withTimeout } from './connect';
import type { BrowserLike, PageLike } from './types';

function fakePage(): PageLike {
  return {
    goto: () => Promise.resolve(null),
    waitForLoadState: () => Promise.resolve(),
    evaluate: <T>(_s: string) => Promise.resolve(undefined as T),
    locator: () => {
      throw new Error('unused');
    },
    frameLocator: () => {
      throw new Error('unused');
    },
    screenshot: () => Promise.resolve(new Uint8Array()),
    url: () => 'https://x.com',
  };
}

describe('getPage', () => {
  it('returns the first page of the first context', () => {
    const page = fakePage();
    const browser: BrowserLike = {
      contexts: () => [{ pages: () => [page] }],
      close: () => Promise.resolve(),
    };
    expect(getPage(browser)).toBe(page);
  });

  it('throws when the session has no page', () => {
    const browser: BrowserLike = {
      contexts: () => [{ pages: () => [] }],
      close: () => Promise.resolve(),
    };
    expect(() => getPage(browser)).toThrow('No page available');
  });

  it('throws when the session has no context', () => {
    const browser: BrowserLike = { contexts: () => [], close: () => Promise.resolve() };
    expect(() => getPage(browser)).toThrow('No page available');
  });
});

describe('withTimeout', () => {
  it('resolves a fast promise', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'op')).resolves.toBe(42);
  });

  it('propagates a rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'op')).rejects.toThrow(
      'boom'
    );
  });

  it('rejects when the promise outlives the timeout', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50));
    await expect(withTimeout(slow, 5, 'slow op')).rejects.toThrow('slow op timed out after 5ms');
  });
});
