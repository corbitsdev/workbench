/**
 * Shared types for the browser tool package.
 *
 * The package is a thin CDP client over a Browserbase-hosted browser. Tools are
 * constructed fresh per call (the hub rebuilds them on every `/tools/run`), so
 * NO browser state is held in closures: the live browser lives on Browserbase,
 * keyed by a `sessionId` the agent passes as a tool argument. Every call
 * reconnects over CDP, acts, and disconnects.
 *
 * The reasoning loop (act / extract / observe) lives in the AGENT, not here —
 * hub tools cannot reach inference. These tools are the hands; Bobby is the
 * brain.
 */

export type BrowserFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A minimal structural view of the Playwright objects the tools touch. Keeping
 * the surface tiny lets tests inject fakes without a real browser and without
 * importing playwright-core into the test process.
 */
export interface LocatorLike {
  count(): Promise<number>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially(value: string, options?: { timeout?: number }): Promise<void>;
  first(): LocatorLike;
  innerText(options?: { timeout?: number }): Promise<string>;
}

/** A frame handle, used to reach elements inside (possibly nested) iframes. */
export interface FrameLocatorLike {
  locator(selector: string): LocatorLike;
  frameLocator(selector: string): FrameLocatorLike;
}

export interface PageLike {
  goto(
    url: string,
    options?: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number }
  ): Promise<unknown>;
  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    options?: { timeout?: number }
  ): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
  locator(selector: string): LocatorLike;
  frameLocator(selector: string): FrameLocatorLike;
  screenshot(options?: { fullPage?: boolean }): Promise<Uint8Array>;
  url(): string;
}

export interface BrowserContextLike {
  pages(): PageLike[];
}

export interface BrowserLike {
  contexts(): BrowserContextLike[];
  close(): Promise<void>;
}

/** Connects to a Browserbase session over CDP and returns the live browser. */
export type BrowserConnector = (connectUrl: string) => Promise<BrowserLike>;

export type BrowserToolsConfig = {
  apiKey: string;
  /** Browserbase REST API base, e.g. `https://api.browserbase.com/v1`. */
  baseUrl?: string;
  /** Browserbase project id. Required to create sessions. */
  projectId?: string;
  fetcher?: BrowserFetch;
  connector?: BrowserConnector;
  /** Hard ceiling per tool call (connect + action), ms. Defaults to OPERATION_BUDGET_MS. */
  operationBudgetMs?: number;
};

/** Config with required values resolved and validated. */
export type ResolvedBrowserConfig = {
  apiKey: string;
  baseUrl: string;
  projectId: string;
  fetcher: BrowserFetch;
  connector: BrowserConnector;
  operationBudgetMs: number;
};

/**
 * A raw interactive element as returned by the in-page snapshot script. Pruning,
 * ref selection, and capping all happen in Node (pure, testable) over arrays of
 * these — the browser only reports facts.
 */
export type RawElement = {
  tag: string;
  role: string | null;
  name: string | null;
  id: string | null;
  testId: string | null;
  nameAttr: string | null;
  ariaLabel: string | null;
  text: string | null;
  /** Tag-qualified nth-of-type path within the element's own document/root. */
  path: string;
  /**
   * Frame chain selector when the element lives inside one or more same-origin
   * iframes (joined by ` >>> `); null for the top document. Shadow-DOM elements
   * stay in their host's frame and carry null here — Playwright CSS pierces open
   * shadow roots, so their ref resolves from the page directly.
   */
  frame: string | null;
  visible: boolean;
};

export type SnapshotElement = {
  /** Stable selector the agent passes back to click/type. */
  ref: string;
  role: string;
  name: string;
};

export type SnapshotResult = {
  url: string;
  elements: SnapshotElement[];
  /** True when the element list was capped; the agent should narrow its task. */
  truncated: boolean;
  /** Count of iframes detected on the page (their contents are NOT included). */
  iframeCount: number;
};
