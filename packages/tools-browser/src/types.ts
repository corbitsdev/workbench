export type BrowserFetch = (input: string, init: RequestInit) => Promise<Response>;

export type BrowserToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  projectId?: string;
  // Injected so tests drive the REST surface without real network. Defaults to
  // global `fetch` in resolveConfig.
  fetcher?: BrowserFetch;
  operationBudgetMs?: number;
};

export type ResolvedBrowserConfig = {
  apiKey: string;
  baseUrl: string;
  projectId: string;
  fetcher: BrowserFetch;
  operationBudgetMs: number;
};

// A raw interactive element from the in-page snapshot script. Pruning, ref
// selection, and capping all happen in Node over arrays of these.
export type RawElement = {
  tag: string;
  role: string | null;
  name: string | null;
  id: string | null;
  testId: string | null;
  nameAttr: string | null;
  ariaLabel: string | null;
  text: string | null;
  path: string;
  // Frame-chain selector when the element is inside same-origin iframes (joined
  // by ` >>> `); null for the top document and shadow-DOM elements.
  frame: string | null;
  visible: boolean;
};

export type SnapshotElement = {
  ref: string;
  role: string;
  name: string;
};

export type SnapshotResult = {
  url: string;
  elements: SnapshotElement[];
  truncated: boolean;
  iframeCount: number;
};
