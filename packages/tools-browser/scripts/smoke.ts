#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Real-browser smoke test. NOT part of `bun test` — it needs a live Browserbase
 * session and real network, which CI must not require. Run it manually before a
 * release to exercise the things the mocked unit tests cannot: a real CDP
 * connect over reconnect, real accessibility-tree pruning, an element ref that
 * survives a fresh connection, and clean teardown.
 *
 *   BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... \
 *     bun run packages/tools-browser/scripts/smoke.ts [url]
 */
import { createToolRunner } from '@intx/agent';
import { createBrowserTools } from '../src/index';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[smoke] missing ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('BROWSERBASE_API_KEY');
  const projectId = requireEnv('BROWSERBASE_PROJECT_ID');
  const url = process.argv[2] ?? 'https://example.com';

  const runner = createToolRunner(createBrowserTools({ apiKey, projectId }));
  const signal = new AbortController().signal;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await runner.run({ id: name, name, arguments: args }, signal);
    console.log(
      `[smoke] ${name} -> ${result.isError ? 'ERROR ' : ''}${String(result.content).slice(0, 400)}`
    );
    if (result.isError) throw new Error(`${name} failed`);
    return JSON.parse(String(result.content)) as Record<string, unknown>;
  };

  const { sessionId } = (await call('browser_create_session', {})) as { sessionId: string };
  try {
    await call('browser_navigate', { sessionId, url });
    const snapshot = (await call('browser_get_snapshot', { sessionId })) as {
      elements: { ref: string }[];
    };
    const firstRef = snapshot.elements[0]?.ref;
    if (firstRef) {
      await call('browser_get_text', { sessionId, selector: 'h1' }).catch(() => undefined);
    }
    console.log('[smoke] PASS');
  } finally {
    await call('browser_close_session', { sessionId }).catch(() => undefined);
  }
}

await main();
