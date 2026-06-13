/**
 * CDP connection helpers. `realConnector` is the only place playwright-core is
 * imported, so tests can inject a fake connector and never load a browser.
 */
import { chromium } from 'playwright-core';
import type { BrowserConnector, BrowserLike, PageLike } from './types';

export const CONNECT_TIMEOUT_MS = 20_000;
export const ACTION_TIMEOUT_MS = 15_000;

export const realConnector: BrowserConnector = async (connectUrl: string) => {
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: CONNECT_TIMEOUT_MS });
  return browser as unknown as BrowserLike;
};

/**
 * Browserbase sessions start with a single context holding the live page. Pick
 * it, or fail loud — we never create pages implicitly, so the agent's mental
 * model (one tab per session) stays true.
 */
export function getPage(browser: BrowserLike): PageLike {
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!page) {
    throw new Error('No page available in the browser session');
  }
  return page;
}

/** Reject if a promise outlives `ms`, so a hung CDP op never ties up a hub slot. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
