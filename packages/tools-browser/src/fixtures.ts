// Shared test fixtures. A CDP-driving test file installs the playwright mock
// itself with `mock.module('playwright-core', playwrightMockFactory)` at the top
// — bun only hoists `mock.module` above static imports when it lives in the test
// file, not when buried in an imported module.
import { mock } from "bun:test";
import type { Browser, FrameLocator, Locator, Page } from "playwright-core";
import type { BrowserFetch, RawElement } from "./types";

export const cdpControl: {
  browser: Browser | null;
  lastConnectUrl: string;
  hang: boolean;
  error: Error | null;
} = { browser: null, lastConnectUrl: "", hang: false, error: null };

export function resetCdpControl(): void {
  cdpControl.browser = null;
  cdpControl.lastConnectUrl = "";
  cdpControl.hang = false;
  cdpControl.error = null;
}

export function playwrightMockFactory() {
  return {
    chromium: {
      connectOverCDP: (url: string) => {
        cdpControl.lastConnectUrl = url;
        if (cdpControl.hang) {
          return new Promise(() => {});
        }
        if (cdpControl.error) {
          return Promise.reject(cdpControl.error);
        }
        return Promise.resolve(cdpControl.browser);
      },
    },
  };
}

export function makeFetchStub(
  response: unknown,
  status = 200,
): BrowserFetch & { mock: { calls: [string, RequestInit][] } } {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

export type RoutedFetch = BrowserFetch & { posts: string[] };

export function routedFetch(sessions: unknown[]): RoutedFetch {
  const posts: string[] = [];
  const fetcher = ((input: string, init: RequestInit) => {
    if ((init.method ?? "GET") === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(sessions), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    posts.push(input);
    return Promise.resolve(
      new Response(JSON.stringify({ status: "RELEASED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as RoutedFetch;
  fetcher.posts = posts;
  return fetcher;
}

// Routes the full session lifecycle: create, status (RUNNING), release.
export function makeSessionFetchStub(
  sessionId = "sess-1",
  connectUrl = "wss://fake-connect",
) {
  return mock((input: string, init: RequestInit) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && !input.endsWith(`/${sessionId}`)) {
      return jsonResponse({ id: sessionId, connectUrl });
    }
    if (method === "GET") {
      return jsonResponse({ id: sessionId, status: "RUNNING" });
    }
    return jsonResponse({});
  }) as BrowserFetch & { mock: { calls: [string, RequestInit][] } };
}

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export type FakePageOptions = {
  counts?: Record<string, number>;
  texts?: Record<string, string>;
  raw?: { elements: RawElement[]; iframeCount: number };
  url?: string;
  onClick?: () => void;
  fillThrows?: boolean;
  onPressSequentially?: () => void;
};

// Fakes implement only the members the tools call, then cast to the playwright
// type. The cast is contained here so production code and tests stay cast-free.
function makeLocator(selector: string, opts: FakePageOptions): Locator {
  const locator = {
    count: () => Promise.resolve(opts.counts?.[selector] ?? 0),
    click: () => {
      opts.onClick?.();
      return Promise.resolve();
    },
    fill: () =>
      opts.fillThrows
        ? Promise.reject(new Error("not fillable"))
        : Promise.resolve(),
    pressSequentially: () => {
      opts.onPressSequentially?.();
      return Promise.resolve();
    },
    first: () => locator,
    innerText: () => Promise.resolve(opts.texts?.[selector] ?? ""),
  };
  return locator as unknown as Locator;
}

// frameLocator(parts...).locator(inner) recomposes the original `a >>> b` ref,
// so counts can be keyed by the ref the snapshot emitted.
function makeFrameLocator(prefix: string, opts: FakePageOptions): FrameLocator {
  return {
    locator: (inner: string) => makeLocator(`${prefix} >>> ${inner}`, opts),
    frameLocator: (next: string) =>
      makeFrameLocator(`${prefix} >>> ${next}`, opts),
  } as unknown as FrameLocator;
}

export function makeBrowser(opts: FakePageOptions): {
  browser: Browser;
  closed: () => boolean;
} {
  let closedFlag = false;
  const page = {
    goto: () => Promise.resolve(null),
    waitForLoadState: () => Promise.resolve(),
    evaluate: <T>(_script: string) =>
      Promise.resolve((opts.raw ?? { elements: [], iframeCount: 0 }) as T),
    locator: (selector: string) => makeLocator(selector, opts),
    frameLocator: (selector: string) => makeFrameLocator(selector, opts),
    screenshot: () => Promise.resolve(Buffer.from([1, 2, 3])),
    url: () => opts.url ?? "https://example.com",
  } as unknown as Page;
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    close: () => {
      closedFlag = true;
      return Promise.resolve();
    },
  } as unknown as Browser;
  return { browser, closed: () => closedFlag };
}

export function installBrowser(opts: FakePageOptions): {
  closed: () => boolean;
} {
  const { browser, closed } = makeBrowser(opts);
  cdpControl.browser = browser;
  return { closed };
}
