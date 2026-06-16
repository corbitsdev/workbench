/**
 * CDP connection helpers. `realConnector` is the only place playwright-core is
 * imported, so tests can inject a fake connector and never load a browser.
 */
import { chromium } from 'playwright-core';
import type { BrowserConnector, BrowserLike, PageLike } from './types';

/**
 * The hub fronts `/tools/run` behind a request budget (~20s on the current
 * Railway/Hono edge) after which the request is torn down. Every in-tool
 * timeout below MUST stay under this so a hung browser op returns a clean
 * `isError` result the agent can act on, rather than racing the teardown.
 * Kept as a documented reference point for the ordering invariant, not a
 * runtime limit we enforce ourselves.
 */
export const EDGE_REQUEST_BUDGET_MS = 20_000;

/**
 * Hard ceiling on a single browser tool call (connect + the one action). Below
 * the edge budget by a margin so the tool always resolves/rejects first.
 */
export const OPERATION_BUDGET_MS = 18_000;

// browser_create_session now guarantees the session is RUNNING before returning,
// so CDP connect should succeed quickly. 15s gives headroom for Browserbase's
// CDP bridge to become reachable after the status flip, while leaving 3s for
// the action itself within the 18s operation budget.
export const CONNECT_TIMEOUT_MS = 15_000;
export const ACTION_TIMEOUT_MS = 9_000;

export const realConnector: BrowserConnector = async (connectUrl: string) => {
  console.log("Browserbase Connect URL: ", connectUrl);
  const browser = await chromium.connectOverCDP(connectUrl); // Temp Removal Experiment, --  { timeout: CONNECT_TIMEOUT_MS }
  console.log("Browser: ", browser)
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
