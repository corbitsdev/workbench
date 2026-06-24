import { describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { ATTIO_HUB_TOOLS, type AttioFetch, createAttioTools } from './index';

type FetchStub = AttioFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeFetchStub(response: unknown, status = 200): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

describe('createAttioTools', () => {
  it('exposes the read-only tools', () => {
    const tools = createAttioTools({ apiKey: 'test-key' });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual([
      'attio_get_record',
      'attio_list_objects',
      'attio_list_workspace_members',
      'attio_query_records',
      'attio_search_records',
    ]);
  });

  it('throws when apiKey is empty', () => {
    expect(() => createAttioTools({ apiKey: '' })).toThrow('Attio apiKey is required');
  });

  it('throws when baseUrl is invalid', () => {
    expect(() => createAttioTools({ apiKey: 'test-key', baseUrl: 'not-a-url' })).toThrow(
      'Attio baseUrl must be a valid URL'
    );
  });
});

describe('attio_list_objects handler', () => {
  it('GETs /v2/objects with a Bearer header and returns the data field', async () => {
    const fetcher = makeFetchStub({ data: [{ api_slug: 'companies' }] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'attio_list_objects', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual([{ api_slug: 'companies' }]);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('https://api.attio.com/v2/objects');
    expect(call?.[1].method).toBe('GET');
    const headers = call?.[1].headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer test-key');
  });
});

describe('attio_query_records handler', () => {
  it('POSTs to the encoded object query path with default pagination body', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    await runner.run(
      {
        id: 'call_1',
        name: 'attio_query_records',
        arguments: { object: 'companies' },
      },
      new AbortController().signal
    );

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('https://api.attio.com/v2/objects/companies/records/query');
    expect(call?.[1].method).toBe('POST');
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
    });
  });

  it('caps limit at 100 and forwards offset', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    await runner.run(
      {
        id: 'call_1',
        name: 'attio_query_records',
        arguments: { object: 'people', limit: 500, offset: 40 },
      },
      new AbortController().signal
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect(body).toEqual({ limit: 100, offset: 40 });
  });

  it('url-encodes the object slug', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    await runner.run(
      {
        id: 'call_1',
        name: 'attio_query_records',
        arguments: { object: 'my objects' },
      },
      new AbortController().signal
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api.attio.com/v2/objects/my%20objects/records/query'
    );
  });

  it('requires the object argument', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'attio_query_records', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('object is required');
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it('forwards a filter object into the request body', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    await runner.run(
      {
        id: 'call_1',
        name: 'attio_query_records',
        arguments: {
          object: 'companies',
          filter: { name: { $contains: 'Tribe Capital' } },
        },
      },
      new AbortController().signal
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
      filter: { name: { $contains: 'Tribe Capital' } },
    });
  });

  it('forwards a sorts array into the request body', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    await runner.run(
      {
        id: 'call_1',
        name: 'attio_query_records',
        arguments: {
          object: 'companies',
          sorts: [{ attribute: 'name', direction: 'asc' }],
        },
      },
      new AbortController().signal
    );

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
      limit: 25,
      offset: 0,
      sorts: [{ attribute: 'name', direction: 'asc' }],
    });
  });

  it('omits filter and sorts from the body when not provided', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    await runner.run(
      {
        id: 'call_1',
        name: 'attio_query_records',
        arguments: { object: 'companies' },
      },
      new AbortController().signal
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    expect('filter' in body).toBe(false);
    expect('sorts' in body).toBe(false);
  });
});

describe('attio_search_records handler', () => {
  it('POSTs the query to /v2/records/search and returns the data field', async () => {
    const fetcher = makeFetchStub({ data: [{ id: { record_id: 'rec_1' } }] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      {
        id: 'call_1',
        name: 'attio_search_records',
        arguments: { query: 'Tribe Capital' },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual([{ id: { record_id: 'rec_1' } }]);

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('https://api.attio.com/v2/records/search');
    expect(call?.[1].method).toBe('POST');
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      query: 'Tribe Capital',
    });
  });

  it('requires the query argument', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'attio_search_records', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('query is required');
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe('attio_get_record handler', () => {
  it('GETs the encoded record path and returns the data field', async () => {
    const fetcher = makeFetchStub({ data: { id: { record_id: 'rec_1' } } });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      {
        id: 'call_1',
        name: 'attio_get_record',
        arguments: { object: 'companies', recordId: 'rec/1' },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      id: { record_id: 'rec_1' },
    });

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('https://api.attio.com/v2/objects/companies/records/rec%2F1');
    expect(call?.[1].method).toBe('GET');
  });

  it('requires the recordId argument', async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      {
        id: 'call_1',
        name: 'attio_get_record',
        arguments: { object: 'companies' },
      },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('recordId is required');
    expect(fetcher.mock.calls).toHaveLength(0);
  });
});

describe('attio_list_workspace_members handler', () => {
  it('GETs /v2/workspace-members', async () => {
    const fetcher = makeFetchStub({
      data: [{ id: { workspace_member_id: 'wm_1' } }],
    });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'attio_list_workspace_members', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.attio.com/v2/workspace-members');
    expect(JSON.parse(String(result.content))).toEqual([{ id: { workspace_member_id: 'wm_1' } }]);
  });
});

describe('error handling', () => {
  it('surfaces API errors with a parsed message', async () => {
    const fetcher = makeFetchStub({ message: 'Invalid token' }, 401);
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'attio_list_objects', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Attio API error: 401 Invalid token');
  });

  it('uses the HTTP status text when the error body is empty', async () => {
    const fetcher: AttioFetch = mock(() =>
      Promise.resolve(new Response('', { status: 502, statusText: 'Bad Gateway' }))
    );
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'attio_list_objects', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Attio API error: 502 Bad Gateway');
  });

  it('surfaces a non-JSON error body verbatim', async () => {
    const fetcher: AttioFetch = mock(() =>
      Promise.resolve(new Response('rate limited', { status: 429, statusText: '' }))
    );
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      {
        id: 'call_1',
        name: 'attio_query_records',
        arguments: { object: 'companies' },
      },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Attio API error: 429 rate limited');
  });

  it('errors when the response is missing the data field', async () => {
    const fetcher = makeFetchStub({ notData: [] });
    const runner = createToolRunner(createAttioTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'attio_list_objects', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Attio response is missing the data field');
  });
});

describe('ATTIO_HUB_TOOLS', () => {
  it('builds each tool from resolved credentials under the attio provider', () => {
    for (const [name, entry] of Object.entries(ATTIO_HUB_TOOLS)) {
      expect(entry.providerName).toBe('attio');
      expect(entry.definition.name).toBe(name);
      const tools = entry.createTools({
        apiKey: 'k',
        baseURL: 'https://api.attio.com',
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.definition.name).toBe(name);
    }
  });

  it('honors a non-empty baseURL override', async () => {
    const fetcher = makeFetchStub({ data: [] });
    const tools = ATTIO_HUB_TOOLS.attio_list_objects.createTools({
      apiKey: 'k',
      baseURL: 'https://eu.attio.test',
    });
    // The hub createTools path does not accept a fetcher, so exercise the default
    // base resolution via createAttioTools directly to confirm override behavior.
    const direct = createAttioTools({
      apiKey: 'k',
      baseUrl: 'https://eu.attio.test',
      fetcher,
    });
    const runner = createToolRunner(direct);
    await runner.run(
      { id: 'c', name: 'attio_list_objects', arguments: {} },
      new AbortController().signal
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://eu.attio.test/v2/objects');
    expect(tools).toHaveLength(1);
  });
});
