/**
 * @workbench/tools-browser — granular browser-control tools over a
 * Browserbase-hosted browser.
 *
 * The tools are the hands; the agent (Bobby) is the reasoning loop. act /
 * extract / observe are NOT tools here — they are a prompt skill on the agent,
 * because hub tools cannot reach inference. Each tool reconnects to the
 * Browserbase session over CDP, performs one action, and disconnects.
 */
import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import {
  clampTimeoutSeconds,
  createSession,
  endSession,
  lookupSessionConnectURL,
  parseBrowserbaseBaseURL,
  removeSessionConnectURL,
  resolveConfig,
  storeSessionConnectURL,
} from './browserbase';
import { ACTION_TIMEOUT_MS, CONNECT_TIMEOUT_MS, getPage, withTimeout } from './connect';
import { FRAME_DELIMITER, pruneSnapshot, SNAPSHOT_SCRIPT, type RawSnapshot } from './snapshot';
import type { BrowserToolsConfig, LocatorLike, PageLike, ResolvedBrowserConfig } from './types';

export type {
  BrowserConnector,
  BrowserFetch,
  BrowserToolsConfig,
  BrowserLike,
  PageLike,
  LocatorLike,
  SnapshotElement,
  SnapshotResult,
  RawElement,
} from './types';
export {
  parseBrowserbaseBaseURL,
  resolveConfig,
  listRunningSessions,
  reapStaleSessions,
  DEFAULT_SESSION_TIMEOUT_SECONDS,
  type BrowserbaseSession,
} from './browserbase';
export { buildRef, pruneSnapshot, MAX_SNAPSHOT_ELEMENTS, SNAPSHOT_SCRIPT } from './snapshot';

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

async function withSession<T>(
  config: ResolvedBrowserConfig,
  sessionId: string,
  fn: (page: PageLike) => Promise<T>
): Promise<T> {
  return withTimeout(
    runSession(config, sessionId, fn),
    config.operationBudgetMs,
    'browser operation'
  );
}

async function runSession<T>(
  config: ResolvedBrowserConfig,
  sessionId: string,
  fn: (page: PageLike) => Promise<T>
): Promise<T> {
  const connectUrl = lookupSessionConnectURL(sessionId);
  const browser = await withTimeout(
    config.connector(connectUrl),
    CONNECT_TIMEOUT_MS,
    'CDP connect'
  );
  try {
    return await fn(getPage(browser));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Build a locator from a ref, walking any frame chain (`<frame> >>> <inner>`,
 * nested frames joined by the same delimiter) via frameLocator so iframe
 * elements resolve.
 */
function locatorForRef(page: PageLike, ref: string): LocatorLike {
  if (!ref.includes(FRAME_DELIMITER)) {
    return page.locator(ref);
  }
  const parts = ref.split(FRAME_DELIMITER);
  const inner = parts.pop() ?? ref;
  let frame = page.frameLocator(parts[0] ?? '');
  for (const frameSelector of parts.slice(1)) {
    frame = frame.frameLocator(frameSelector);
  }
  return frame.locator(inner);
}

/** Resolve a ref to exactly one element, or fail loud so the agent re-snapshots. */
async function resolveUnique(page: PageLike, ref: string): Promise<LocatorLike> {
  const locator = locatorForRef(page, ref);
  const count = await locator.count();
  if (count === 0) {
    throw new Error(
      `No element matches ref "${ref}". The page likely changed — call browser_get_snapshot again for fresh refs.`
    );
  }
  if (count > 1) {
    throw new Error(
      `Ref "${ref}" matches ${count} elements (ambiguous). Call browser_get_snapshot again for a fresh, unique ref.`
    );
  }
  return locator;
}

async function settle(page: PageLike): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
}

export const BROWSER_CREATE_SESSION_DEFINITION: ToolDefinition = {
  name: 'browser_create_session',
  description:
    'Start a new hosted browser session and return its sessionId. Pass this sessionId to every other browser tool. Always close the session with browser_close_session when finished.',
  inputSchema: {
    type: 'object',
    properties: {
      timeoutSeconds: {
        type: 'number',
        description:
          'Max session lifetime in seconds (60-3600, default 600). The session auto-closes after this.',
      },
    },
    required: [],
  },
};

export const BROWSER_NAVIGATE_DEFINITION: ToolDefinition = {
  name: 'browser_navigate',
  description: 'Navigate the session to a URL and wait for the page to load.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id from browser_create_session.' },
      url: { type: 'string', description: 'Absolute URL to navigate to.' },
    },
    required: ['sessionId', 'url'],
  },
};

export const BROWSER_GET_SNAPSHOT_DEFINITION: ToolDefinition = {
  name: 'browser_get_snapshot',
  description:
    'Return the interactive elements on the current page as a list of { ref, role, name }. Pass a ref to browser_click or browser_type. Refs can go stale after the page changes — re-snapshot if a click fails. The list may be truncated and does not include iframe contents.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id from browser_create_session.' },
    },
    required: ['sessionId'],
  },
};

export const BROWSER_CLICK_DEFINITION: ToolDefinition = {
  name: 'browser_click',
  description: 'Click the element identified by a ref from browser_get_snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id from browser_create_session.' },
      ref: { type: 'string', description: 'Element ref from a recent browser_get_snapshot.' },
    },
    required: ['sessionId', 'ref'],
  },
};

export const BROWSER_TYPE_DEFINITION: ToolDefinition = {
  name: 'browser_type',
  description: 'Type text into the element identified by a ref from browser_get_snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id from browser_create_session.' },
      ref: { type: 'string', description: 'Element ref from a recent browser_get_snapshot.' },
      text: { type: 'string', description: 'Text to enter into the field.' },
    },
    required: ['sessionId', 'ref', 'text'],
  },
};

export const BROWSER_GET_TEXT_DEFINITION: ToolDefinition = {
  name: 'browser_get_text',
  description: 'Return the visible text content of the first element matching a CSS selector.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id from browser_create_session.' },
      selector: { type: 'string', description: 'CSS selector to read text from.' },
    },
    required: ['sessionId', 'selector'],
  },
};

export const BROWSER_SCREENSHOT_DEFINITION: ToolDefinition = {
  name: 'browser_screenshot',
  description: 'Capture a PNG screenshot of the current page, returned as base64.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id from browser_create_session.' },
      fullPage: {
        type: 'boolean',
        description: 'Capture the full scrollable page (default false).',
      },
    },
    required: ['sessionId'],
  },
};

export const BROWSER_CLOSE_SESSION_DEFINITION: ToolDefinition = {
  name: 'browser_close_session',
  description:
    'Release the hosted browser session. Always call this when finished to avoid leaking a paid session.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id from browser_create_session.' },
    },
    required: ['sessionId'],
  },
};

export const BROWSER_DEFINITIONS: ToolDefinition[] = [
  BROWSER_CREATE_SESSION_DEFINITION,
  BROWSER_NAVIGATE_DEFINITION,
  BROWSER_GET_SNAPSHOT_DEFINITION,
  BROWSER_CLICK_DEFINITION,
  BROWSER_TYPE_DEFINITION,
  BROWSER_GET_TEXT_DEFINITION,
  BROWSER_SCREENSHOT_DEFINITION,
  BROWSER_CLOSE_SESSION_DEFINITION,
];

function stringTool(
  definition: ToolDefinition,
  call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
): AgentTool {
  return {
    kind: 'string',
    definition,
    handler: async (args, signal) => jsonResult(await call(args, signal)),
  };
}

export function createBrowserTools(rawConfig: BrowserToolsConfig): AgentTool[] {
  const config = resolveConfig(rawConfig);

  return [
    stringTool(BROWSER_CREATE_SESSION_DEFINITION, async (args, signal) => {
      const timeoutSeconds = clampTimeoutSeconds(args.timeoutSeconds);
      const { sessionId, connectUrl } = await createSession(config, timeoutSeconds, signal);
      storeSessionConnectURL(sessionId, connectUrl);
      return { sessionId, timeoutSeconds };
    }),

    stringTool(BROWSER_NAVIGATE_DEFINITION, async (args) => {
      const sessionId = requiredString(args, 'sessionId');
      const url = requiredString(args, 'url');
      return withSession(config, sessionId, async (page) => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
        await settle(page);
        return { url: page.url() };
      });
    }),

    stringTool(BROWSER_GET_SNAPSHOT_DEFINITION, async (args) => {
      const sessionId = requiredString(args, 'sessionId');
      return withSession(config, sessionId, async (page) => {
        await settle(page);
        const raw = await page.evaluate<RawSnapshot>(SNAPSHOT_SCRIPT);
        return pruneSnapshot(raw, page.url());
      });
    }),

    stringTool(BROWSER_CLICK_DEFINITION, async (args) => {
      const sessionId = requiredString(args, 'sessionId');
      const ref = requiredString(args, 'ref');
      return withSession(config, sessionId, async (page) => {
        const locator = await resolveUnique(page, ref);
        await locator.click({ timeout: ACTION_TIMEOUT_MS });
        return { clicked: ref };
      });
    }),

    stringTool(BROWSER_TYPE_DEFINITION, async (args) => {
      const sessionId = requiredString(args, 'sessionId');
      const ref = requiredString(args, 'ref');
      const text = requiredString(args, 'text');
      return withSession(config, sessionId, async (page) => {
        const locator = await resolveUnique(page, ref);
        // fill() is fastest and covers inputs/textarea/contenteditable. Custom
        // editable widgets (role=textbox without a fillable host) reject it, so
        // fall back to focusing and typing key-by-key.
        try {
          await locator.fill(text, { timeout: ACTION_TIMEOUT_MS });
          return { typed: ref, method: 'fill' };
        } catch {
          await locator.click({ timeout: ACTION_TIMEOUT_MS });
          await locator.pressSequentially(text, { timeout: ACTION_TIMEOUT_MS });
          return { typed: ref, method: 'pressSequentially' };
        }
      });
    }),

    stringTool(BROWSER_GET_TEXT_DEFINITION, async (args) => {
      const sessionId = requiredString(args, 'sessionId');
      const selector = requiredString(args, 'selector');
      return withSession(config, sessionId, async (page) => {
        const locator = page.locator(selector);
        if ((await locator.count()) === 0) {
          throw new Error(`No element matches selector "${selector}".`);
        }
        return { text: await locator.first().innerText({ timeout: ACTION_TIMEOUT_MS }) };
      });
    }),

    stringTool(BROWSER_SCREENSHOT_DEFINITION, async (args) => {
      const sessionId = requiredString(args, 'sessionId');
      const fullPage = args.fullPage === true;
      return withSession(config, sessionId, async (page) => {
        const bytes = await page.screenshot({ fullPage });
        return {
          mimeType: 'image/png',
          encoding: 'base64',
          imageBase64: Buffer.from(bytes).toString('base64'),
        };
      });
    }),

    stringTool(BROWSER_CLOSE_SESSION_DEFINITION, async (args, signal) => {
      const sessionId = requiredString(args, 'sessionId');
      try {
        await endSession(config, sessionId, signal);
      } finally {
        removeSessionConnectURL(sessionId);
      }
      return { closed: true, sessionId };
    }),
  ];
}

function createBrowserToolByName(config: BrowserToolsConfig, name: string): AgentTool[] {
  return createBrowserTools(config).filter((tool) => tool.definition.name === name);
}

/**
 * Hub registry entries. The hub passes a single `baseURL` string per credential;
 * the Browserbase project id rides on it as `?projectId=` and is split out here.
 */
export const BROWSER_HUB_TOOLS = Object.fromEntries(
  BROWSER_DEFINITIONS.map((definition) => [
    definition.name,
    {
      definition,
      providerName: 'browserbase' as const,
      createTools: (config: { apiKey: string; baseURL: string }) => {
        const { baseUrl, projectId } = parseBrowserbaseBaseURL(config.baseURL);
        return createBrowserToolByName(
          {
            apiKey: config.apiKey,
            baseUrl,
            ...(projectId ? { projectId } : {}),
          },
          definition.name
        );
      },
    },
  ])
);
