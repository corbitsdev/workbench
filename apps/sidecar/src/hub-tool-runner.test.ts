import { describe, it, expect, mock, afterEach } from 'bun:test';
import type { ToolCall, ToolDefinition } from '@intx/types/runtime';
import { createHubToolRunner } from './hub-tool-runner';

const HUB_HTTP_URL = 'http://hub.example.com:8080';

const definitions: ToolDefinition[] = [
  { name: 'exa_search', description: 'search', inputSchema: { type: 'object', properties: {} } },
];

const call: ToolCall = { id: 'call-1', name: 'exa_search', arguments: { query: 'hello' } };

function makeRunner() {
  return createHubToolRunner({
    hubHttpUrl: HUB_HTTP_URL,
    sidecarToken: 'test-token',
    tenantId: 'tenant-1',
    toolDefinitions: definitions,
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createHubToolRunner', () => {
  it('targets the hub internal tool-run endpoint', async () => {
    const fetchMock = mock(
      async () => new Response(JSON.stringify({ result: 'ok', isError: false }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await makeRunner().run(call, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(
      `${HUB_HTTP_URL}/api/internal/tools/run`
    );
  });

  it('returns the tool result on a successful response', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ result: 'search results', isError: false }), { status: 200 })
    ) as unknown as typeof fetch;

    const res = await makeRunner().run(call, new AbortController().signal);

    expect(res).toEqual({ callId: 'call-1', content: 'search results', isError: false });
  });

  it('surfaces the status on a non-OK non-JSON response instead of a parse error', async () => {
    globalThis.fetch = mock(
      async () => new Response('Not Found', { status: 404, statusText: 'Not Found' })
    ) as unknown as typeof fetch;

    const res = await makeRunner().run(call, new AbortController().signal);

    expect(res.isError).toBe(true);
    expect(res.content).toContain('404');
    expect(res.content).not.toContain('JSON');
  });
});
