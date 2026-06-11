import { describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { BROWSER_HUB_TOOLS, createBrowserTools } from './index';
import type {
  BrowserConnector,
  BrowserFetch,
  BrowserLike,
  FrameLocatorLike,
  LocatorLike,
  PageLike,
  RawElement,
} from './types';

function makeFetchStub(
  response: unknown,
  status = 200
): BrowserFetch & { mock: { calls: [string, RequestInit][] } } {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

type FakePageOptions = {
  counts?: Record<string, number>;
  texts?: Record<string, string>;
  raw?: { elements: RawElement[]; iframeCount: number };
  url?: string;
  onClick?: () => void;
  fillThrows?: boolean;
  onPressSequentially?: () => void;
};

function makeLocator(selector: string, opts: FakePageOptions): LocatorLike {
  const locator: LocatorLike = {
    count: () => Promise.resolve(opts.counts?.[selector] ?? 0),
    click: () => {
      opts.onClick?.();
      return Promise.resolve();
    },
    fill: () => (opts.fillThrows ? Promise.reject(new Error('not fillable')) : Promise.resolve()),
    pressSequentially: () => {
      opts.onPressSequentially?.();
      return Promise.resolve();
    },
    first: () => locator,
    innerText: () => Promise.resolve(opts.texts?.[selector] ?? ''),
  };
  return locator;
}

// frameLocator(parts...).locator(inner) recomposes the original `a >>> b` ref,
// so counts can be keyed by the ref the snapshot emitted.
function makeFrameLocator(prefix: string, opts: FakePageOptions): FrameLocatorLike {
  return {
    locator: (inner: string) => makeLocator(`${prefix} >>> ${inner}`, opts),
    frameLocator: (next: string) => makeFrameLocator(`${prefix} >>> ${next}`, opts),
  };
}

function makeBrowser(opts: FakePageOptions): { browser: BrowserLike; closed: () => boolean } {
  let closedFlag = false;
  const page: PageLike = {
    goto: () => Promise.resolve(null),
    waitForLoadState: () => Promise.resolve(),
    evaluate: <T>(_script: string) =>
      Promise.resolve((opts.raw ?? { elements: [], iframeCount: 0 }) as T),
    locator: (selector: string) => makeLocator(selector, opts),
    frameLocator: (selector: string) => makeFrameLocator(selector, opts),
    screenshot: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    url: () => opts.url ?? 'https://example.com',
  };
  const browser: BrowserLike = {
    contexts: () => [{ pages: () => [page] }],
    close: () => {
      closedFlag = true;
      return Promise.resolve();
    },
  };
  return { browser, closed: () => closedFlag };
}

function runnerFor(
  opts: FakePageOptions,
  fetcher: BrowserFetch,
  onConnect?: (url: string) => void
) {
  const connector: BrowserConnector = (url) => {
    onConnect?.(url);
    return Promise.resolve(makeBrowser(opts).browser);
  };
  return createToolRunner(createBrowserTools({ apiKey: 'k', projectId: 'p', fetcher, connector }));
}

const signal = () => new AbortController().signal;

describe('createBrowserTools', () => {
  it('returns all eight tools', () => {
    const tools = createBrowserTools({ apiKey: 'k', projectId: 'p' });
    expect(tools.map((t) => t.definition.name)).toEqual([
      'browser_create_session',
      'browser_navigate',
      'browser_get_snapshot',
      'browser_click',
      'browser_type',
      'browser_get_text',
      'browser_screenshot',
      'browser_close_session',
    ]);
  });

  it('fails loud without a projectId', () => {
    expect(() => createBrowserTools({ apiKey: 'k' })).toThrow('projectId is required');
  });
});

describe('browser_create_session', () => {
  it('creates a session and returns the id and clamped timeout', async () => {
    const fetcher = makeFetchStub({ id: 'sess-1' });
    const runner = runnerFor({}, fetcher);
    const result = await runner.run(
      { id: 'c1', name: 'browser_create_session', arguments: { timeoutSeconds: 9999 } },
      signal()
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      sessionId: 'sess-1',
      timeoutSeconds: 3600,
    });
  });
});

describe('browser_navigate', () => {
  it('navigates and connects with a url derived from the sessionId', async () => {
    let connectUrl = '';
    const runner = runnerFor(
      { url: 'https://dest.com' },
      makeFetchStub({}),
      (u) => (connectUrl = u)
    );
    const result = await runner.run(
      {
        id: 'c1',
        name: 'browser_navigate',
        arguments: { sessionId: 'sess-1', url: 'https://dest.com' },
      },
      signal()
    );
    expect(JSON.parse(String(result.content))).toEqual({ url: 'https://dest.com' });
    expect(connectUrl).toBe('wss://connect.browserbase.com?apiKey=k&sessionId=sess-1');
  });
});

describe('browser_get_snapshot', () => {
  it('returns the pruned snapshot', async () => {
    const raw = {
      elements: [
        {
          tag: 'button',
          role: null,
          name: 'Go',
          id: 'go',
          testId: null,
          nameAttr: null,
          ariaLabel: null,
          text: 'Go',
          path: 'body > button:nth-of-type(1)',
          frame: null,
          visible: true,
        } satisfies RawElement,
      ],
      iframeCount: 1,
    };
    const runner = runnerFor({ raw, url: 'https://x.com' }, makeFetchStub({}));
    const result = await runner.run(
      { id: 'c1', name: 'browser_get_snapshot', arguments: { sessionId: 's' } },
      signal()
    );
    expect(JSON.parse(String(result.content))).toEqual({
      url: 'https://x.com',
      elements: [{ ref: '[id="go"]', role: 'button', name: 'Go' }],
      truncated: false,
      iframeCount: 1,
    });
  });
});

describe('browser_click', () => {
  it('clicks a uniquely-resolved ref', async () => {
    let clicked = false;
    const runner = runnerFor(
      { counts: { '[id="go"]': 1 }, onClick: () => (clicked = true) },
      makeFetchStub({})
    );
    const result = await runner.run(
      { id: 'c1', name: 'browser_click', arguments: { sessionId: 's', ref: '[id="go"]' } },
      signal()
    );
    expect(result.isError).toBeUndefined();
    expect(clicked).toBe(true);
  });

  it('fails loud when the ref matches nothing', async () => {
    const runner = runnerFor({ counts: { '[id="gone"]': 0 } }, makeFetchStub({}));
    const result = await runner.run(
      { id: 'c1', name: 'browser_click', arguments: { sessionId: 's', ref: '[id="gone"]' } },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('browser_get_snapshot again');
  });

  it('fails loud when the ref is ambiguous', async () => {
    const runner = runnerFor({ counts: { '.dup': 3 } }, makeFetchStub({}));
    const result = await runner.run(
      { id: 'c1', name: 'browser_click', arguments: { sessionId: 's', ref: '.dup' } },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ambiguous');
  });

  it('resolves a frame-qualified ref through frameLocator', async () => {
    let clicked = false;
    const ref = 'iframe:nth-of-type(1) >>> button[id="ok"]';
    const runner = runnerFor(
      { counts: { [ref]: 1 }, onClick: () => (clicked = true) },
      makeFetchStub({})
    );
    const result = await runner.run(
      { id: 'c1', name: 'browser_click', arguments: { sessionId: 's', ref } },
      signal()
    );
    expect(result.isError).toBeUndefined();
    expect(clicked).toBe(true);
  });
});

describe('browser_type', () => {
  it('fills a uniquely-resolved ref', async () => {
    const runner = runnerFor({ counts: { 'input[name="q"]': 1 } }, makeFetchStub({}));
    const result = await runner.run(
      {
        id: 'c1',
        name: 'browser_type',
        arguments: { sessionId: 's', ref: 'input[name="q"]', text: 'hi' },
      },
      signal()
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      typed: 'input[name="q"]',
      method: 'fill',
    });
  });

  it('falls back to pressSequentially when fill is not supported', async () => {
    let pressed = false;
    const runner = runnerFor(
      {
        counts: { '[role=textbox]': 1 },
        fillThrows: true,
        onPressSequentially: () => (pressed = true),
      },
      makeFetchStub({})
    );
    const result = await runner.run(
      {
        id: 'c1',
        name: 'browser_type',
        arguments: { sessionId: 's', ref: '[role=textbox]', text: 'hi' },
      },
      signal()
    );
    expect(result.isError).toBeUndefined();
    expect(pressed).toBe(true);
    expect(JSON.parse(String(result.content))).toEqual({
      typed: '[role=textbox]',
      method: 'pressSequentially',
    });
  });
});

describe('browser_get_text', () => {
  it('returns text for a present selector', async () => {
    const runner = runnerFor({ counts: { h1: 1 }, texts: { h1: 'Title' } }, makeFetchStub({}));
    const result = await runner.run(
      { id: 'c1', name: 'browser_get_text', arguments: { sessionId: 's', selector: 'h1' } },
      signal()
    );
    expect(JSON.parse(String(result.content))).toEqual({ text: 'Title' });
  });

  it('fails when the selector matches nothing', async () => {
    const runner = runnerFor({ counts: { h1: 0 } }, makeFetchStub({}));
    const result = await runner.run(
      { id: 'c1', name: 'browser_get_text', arguments: { sessionId: 's', selector: 'h1' } },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No element matches selector');
  });
});

describe('browser_screenshot', () => {
  it('returns a base64 png', async () => {
    const runner = runnerFor({}, makeFetchStub({}));
    const result = await runner.run(
      { id: 'c1', name: 'browser_screenshot', arguments: { sessionId: 's' } },
      signal()
    );
    expect(JSON.parse(String(result.content))).toEqual({
      mimeType: 'image/png',
      encoding: 'base64',
      imageBase64: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'),
    });
  });
});

describe('browser_close_session', () => {
  it('releases the session via the API', async () => {
    const fetcher = makeFetchStub({ status: 'RELEASED' });
    const runner = runnerFor({}, fetcher);
    const result = await runner.run(
      { id: 'c1', name: 'browser_close_session', arguments: { sessionId: 'sess-1' } },
      signal()
    );
    expect(JSON.parse(String(result.content))).toEqual({ closed: true, sessionId: 'sess-1' });
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.browserbase.com/v1/sessions/sess-1');
  });
});

describe('disconnect discipline', () => {
  it('closes the browser even when the action throws', async () => {
    const { browser, closed } = makeBrowser({ counts: { '[id="x"]': 0 } });
    const connector: BrowserConnector = () => Promise.resolve(browser);
    const runner = createToolRunner(
      createBrowserTools({ apiKey: 'k', projectId: 'p', fetcher: makeFetchStub({}), connector })
    );
    const result = await runner.run(
      { id: 'c1', name: 'browser_click', arguments: { sessionId: 's', ref: '[id="x"]' } },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(closed()).toBe(true);
  });
});

describe('BROWSER_HUB_TOOLS', () => {
  it('exposes every tool under the browserbase provider', () => {
    const names = Object.keys(BROWSER_HUB_TOOLS);
    expect(names).toContain('browser_create_session');
    expect(BROWSER_HUB_TOOLS.browser_click!.providerName).toBe('browserbase');
  });

  it('parses projectId out of the credential baseURL', () => {
    const tools = BROWSER_HUB_TOOLS.browser_create_session!.createTools({
      apiKey: 'k',
      baseURL: 'https://api.browserbase.com/v1?projectId=proj-9',
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe('browser_create_session');
  });

  it('fails loud when the baseURL carries no projectId', () => {
    expect(() =>
      BROWSER_HUB_TOOLS.browser_navigate!.createTools({
        apiKey: 'k',
        baseURL: 'https://api.browserbase.com/v1',
      })
    ).toThrow('projectId is required');
  });
});
