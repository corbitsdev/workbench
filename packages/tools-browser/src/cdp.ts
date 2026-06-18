// The only `playwright-core` importer, so tests mock this one module boundary.
import { chromium, type Browser, type Page } from 'playwright-core';
import { CONNECT_TIMEOUT_MS } from './budgets';

export { ACTION_TIMEOUT_MS, CONNECT_TIMEOUT_MS, OPERATION_BUDGET_MS } from './budgets';

export async function connect(connectUrl: string): Promise<Browser> {
  return chromium.connectOverCDP(connectUrl, { timeout: CONNECT_TIMEOUT_MS });
}

export function getPage(browser: Browser): Page {
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!page) {
    throw new Error('No page available in the browser session');
  }
  return page;
}

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
