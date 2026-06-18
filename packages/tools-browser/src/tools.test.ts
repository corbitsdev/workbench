import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import {
  cdpControl,
  installBrowser,
  makeFetchStub,
  makeSessionFetchStub,
  playwrightMockFactory,
  resetCdpControl,
  type FakePageOptions,
} from './fixtures';

mock.module('playwright-core', playwrightMockFactory);

import { clearSessionConnectURLs } from './client';
import { ACTION_TIMEOUT_MS, CONNECT_TIMEOUT_MS, OPERATION_BUDGET_MS } from './cdp';
import { BROWSER_HUB_TOOLS, createBrowserTools } from './tools';
import type { BrowserFetch, RawElement } from './types';

const signal = () => new AbortController().signal;

function runnerFor(opts: FakePageOptions, fetcher: BrowserFetch, operationBudgetMs?: number) {
  installBrowser(opts);
  return createToolRunner(
    createBrowserTools({
      apiKey: 'k',
      projectId: 'p',
      fetcher,
      ...(operationBudgetMs !== undefined ? { operationBudgetMs } : {}),
    })
  );
}

/** Run browser_create_session, then a second tool call, returning the second result. */
async function afterCreate(
  runner: ReturnType<typeof createToolRunner>,
  call: Parameters<typeof runner.run>[0]
) {
  await runner.run({ id: 'c0', name: 'browser_create_session', arguments: {} }, signal());
  return runner.run(call, signal());
}

beforeEach(() => {
  resetCdpControl();
  clearSessionConnectURLs();
});

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
  it('creates a session, stores connectUrl server-side, returns sessionId and timeout to model', async () => {
    const runner = runnerFor({}, makeSessionFetchStub('sess-1', 'wss://browserbase-provided-url'));
    const result = await runner.run(
      {
        id: 'c1',
        name: 'browser_create_session',
        arguments: { timeoutSeconds: 9999 },
      },
      signal()
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed).toEqual({ sessionId: 'sess-1', timeoutSeconds: 3600 });
    expect(parsed).not.toHaveProperty('connectUrl');
  });
});

describe('browser_navigate', () => {
  it('connects with the Browserbase-provided connectUrl, not a synthesized URL', async () => {
    const runner = runnerFor(
      { url: 'https://dest.com' },
      makeSessionFetchStub('sess-1', 'wss://browserbase-provided-url')
    );
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_navigate',
      arguments: { sessionId: 'sess-1', url: 'https://dest.com' },
    });
    expect(JSON.parse(String(result.content))).toEqual({
      url: 'https://dest.com',
    });
    expect(cdpControl.lastConnectUrl).toBe('wss://browserbase-provided-url');
    expect(cdpControl.lastConnectUrl).not.toContain('apiKey=k&sessionId=sess-1');
  });

  it('fails when called without a prior browser_create_session', async () => {
    const runner = runnerFor({ url: 'https://dest.com' }, makeFetchStub({}));
    const result = await runner.run(
      {
        id: 'c1',
        name: 'browser_navigate',
        arguments: { sessionId: 'unknown-session', url: 'https://dest.com' },
      },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown-session');
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
    const runner = runnerFor({ raw, url: 'https://x.com' }, makeSessionFetchStub('sess-1'));
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_get_snapshot',
      arguments: { sessionId: 'sess-1' },
    });
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
      makeSessionFetchStub('sess-1')
    );
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_click',
      arguments: { sessionId: 'sess-1', ref: '[id="go"]' },
    });
    expect(result.isError).toBeUndefined();
    expect(clicked).toBe(true);
  });

  it('fails loud when the ref matches nothing', async () => {
    const runner = runnerFor({ counts: { '[id="gone"]': 0 } }, makeSessionFetchStub('sess-1'));
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_click',
      arguments: { sessionId: 'sess-1', ref: '[id="gone"]' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('browser_get_snapshot again');
  });

  it('fails loud when the ref is ambiguous', async () => {
    const runner = runnerFor({ counts: { '.dup': 3 } }, makeSessionFetchStub('sess-1'));
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_click',
      arguments: { sessionId: 'sess-1', ref: '.dup' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ambiguous');
  });

  it('resolves a frame-qualified ref through frameLocator', async () => {
    let clicked = false;
    const ref = 'iframe:nth-of-type(1) >>> button[id="ok"]';
    const runner = runnerFor(
      { counts: { [ref]: 1 }, onClick: () => (clicked = true) },
      makeSessionFetchStub('sess-1')
    );
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_click',
      arguments: { sessionId: 'sess-1', ref },
    });
    expect(result.isError).toBeUndefined();
    expect(clicked).toBe(true);
  });
});

describe('browser_type', () => {
  it('fills a uniquely-resolved ref', async () => {
    const runner = runnerFor({ counts: { 'input[name="q"]': 1 } }, makeSessionFetchStub('sess-1'));
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_type',
      arguments: { sessionId: 'sess-1', ref: 'input[name="q"]', text: 'hi' },
    });
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
      makeSessionFetchStub('sess-1')
    );
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_type',
      arguments: { sessionId: 'sess-1', ref: '[role=textbox]', text: 'hi' },
    });
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
    const runner = runnerFor(
      { counts: { h1: 1 }, texts: { h1: 'Title' } },
      makeSessionFetchStub('sess-1')
    );
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_get_text',
      arguments: { sessionId: 'sess-1', selector: 'h1' },
    });
    expect(JSON.parse(String(result.content))).toEqual({ text: 'Title' });
  });

  it('fails when the selector matches nothing', async () => {
    const runner = runnerFor({ counts: { h1: 0 } }, makeSessionFetchStub('sess-1'));
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_get_text',
      arguments: { sessionId: 'sess-1', selector: 'h1' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No element matches selector');
  });
});

describe('browser_screenshot', () => {
  it('returns a base64 png', async () => {
    const runner = runnerFor({}, makeSessionFetchStub('sess-1'));
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_screenshot',
      arguments: { sessionId: 'sess-1' },
    });
    expect(JSON.parse(String(result.content))).toEqual({
      mimeType: 'image/png',
      encoding: 'base64',
      imageBase64: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'),
    });
  });
});

describe('browser_close_session', () => {
  it('releases the session via the API and cleans up the connect URL store', async () => {
    const runner = runnerFor({}, makeSessionFetchStub('sess-1'));
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_close_session',
      arguments: { sessionId: 'sess-1' },
    });
    expect(JSON.parse(String(result.content))).toEqual({
      closed: true,
      sessionId: 'sess-1',
    });

    const navResult = await runner.run(
      {
        id: 'c2',
        name: 'browser_navigate',
        arguments: { sessionId: 'sess-1', url: 'https://example.com' },
      },
      signal()
    );
    expect(navResult.isError).toBe(true);
  });

  it('removes the connectUrl from the store even when endSession throws', async () => {
    const runner = runnerFor({}, makeSessionFetchStub('sess-err'));
    await runner.run({ id: 'c0', name: 'browser_create_session', arguments: {} }, signal());

    const errorRunner = createToolRunner(
      createBrowserTools({
        apiKey: 'k',
        projectId: 'p',
        fetcher: makeFetchStub({ message: 'server error' }, 500),
      })
    );
    const closeResult = await errorRunner.run(
      {
        id: 'c1',
        name: 'browser_close_session',
        arguments: { sessionId: 'sess-err' },
      },
      signal()
    );
    expect(closeResult.isError).toBe(true);

    const navResult = await runner.run(
      {
        id: 'c2',
        name: 'browser_navigate',
        arguments: { sessionId: 'sess-err', url: 'https://example.com' },
      },
      signal()
    );
    expect(navResult.isError).toBe(true);
    expect(navResult.content).toContain('sess-err');
  });
});

describe('disconnect discipline', () => {
  it('closes the browser even when the action throws', async () => {
    const { closed } = installBrowser({ counts: { '[id="x"]': 0 } });
    const runner = createToolRunner(
      createBrowserTools({
        apiKey: 'k',
        projectId: 'p',
        fetcher: makeSessionFetchStub('sess-disc'),
      })
    );
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_click',
      arguments: { sessionId: 'sess-disc', ref: '[id="x"]' },
    });
    expect(result.isError).toBe(true);
    expect(closed()).toBe(true);
  });
});

describe('timeout budget', () => {
  it('keeps CONNECT < OPERATION and per-action within the operation budget', () => {
    expect(CONNECT_TIMEOUT_MS).toBeLessThan(OPERATION_BUDGET_MS);
    expect(ACTION_TIMEOUT_MS).toBeLessThanOrEqual(OPERATION_BUDGET_MS);
  });

  it('returns a clean timeout error when the CDP connect hangs', async () => {
    cdpControl.hang = true;
    const runner = createToolRunner(
      createBrowserTools({
        apiKey: 'k',
        projectId: 'p',
        fetcher: makeSessionFetchStub('sess-1'),
        operationBudgetMs: 20,
      })
    );
    const result = await afterCreate(runner, {
      id: 'c1',
      name: 'browser_navigate',
      arguments: { sessionId: 'sess-1', url: 'https://example.com' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/timed out/);
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
