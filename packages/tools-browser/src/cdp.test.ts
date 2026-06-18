import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { cdpControl, installBrowser, playwrightMockFactory, resetCdpControl } from './fixtures';

mock.module('playwright-core', playwrightMockFactory);

import { connect, getPage, withTimeout } from './cdp';
import type { Browser, Page } from 'playwright-core';

beforeEach(resetCdpControl);

function fakePage(): Page {
  return { url: () => 'https://x.com' } as unknown as Page;
}

describe('connect', () => {
  it('connects over CDP at the given URL and returns the live browser', async () => {
    installBrowser({});
    const browser = await connect('wss://browserbase-provided');
    expect(cdpControl.lastConnectUrl).toBe('wss://browserbase-provided');
    expect(browser.contexts()).toHaveLength(1);
  });

  it('propagates a connect failure', async () => {
    cdpControl.error = new Error('CDP refused');
    await expect(connect('wss://x')).rejects.toThrow('CDP refused');
  });
});

describe('getPage', () => {
  it('returns the first page of the first context', () => {
    const page = fakePage();
    const browser = {
      contexts: () => [{ pages: () => [page] }],
    } as unknown as Browser;
    expect(getPage(browser)).toBe(page);
  });

  it('throws when the session has no page', () => {
    const browser = {
      contexts: () => [{ pages: () => [] }],
    } as unknown as Browser;
    expect(() => getPage(browser)).toThrow('No page available');
  });

  it('throws when the session has no context', () => {
    const browser = { contexts: () => [] } as unknown as Browser;
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
