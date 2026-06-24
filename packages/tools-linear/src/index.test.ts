import { describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { createLinearTools, LINEAR_HUB_TOOLS, type LinearFetch } from './index';

type FetchStub = LinearFetch & {
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

function lastBody(fetcher: FetchStub): { query: string; variables: Record<string, unknown> } {
  const call = fetcher.mock.calls[0];
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1].body));
}

describe('createLinearTools', () => {
  it('exposes the four read-only linear tools', () => {
    const tools = createLinearTools({ apiKey: 'test-key' });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual([
      'linear_get_issue',
      'linear_list_issues',
      'linear_list_teams',
      'linear_list_users',
    ]);
  });

  it('throws when apiKey is empty', () => {
    expect(() => createLinearTools({ apiKey: '' })).toThrow('Linear apiKey is required');
  });

  it('throws when baseUrl is invalid', () => {
    expect(() => createLinearTools({ apiKey: 'test-key', baseUrl: 'not-a-url' })).toThrow(
      'Linear baseUrl must be a valid URL'
    );
  });
});

describe('auth and endpoint', () => {
  it('sends the api key as a bare Authorization header against the default endpoint', async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'secret-key', fetcher }));

    await runner.run(
      { id: 'c1', name: 'linear_list_issues', arguments: {} },
      new AbortController().signal
    );

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('https://api.linear.app/graphql');
    const headers = call?.[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('secret-key');
    expect(headers.Authorization).not.toContain('Bearer');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('uses an overridden baseUrl', async () => {
    const fetcher = makeFetchStub({ data: { teams: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: 'k', baseUrl: 'https://proxy.test/gql', fetcher })
    );

    await runner.run(
      { id: 'c1', name: 'linear_list_teams', arguments: {} },
      new AbortController().signal
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe('https://proxy.test/gql');
  });
});

describe('linear_list_issues handler', () => {
  it('lists workspace issues with default first and parses the response', async () => {
    const nodes = [
      {
        id: 'uuid-1',
        identifier: 'ENG-1',
        title: 'Fix bug',
        state: { name: 'In Progress' },
        assignee: { name: 'Ada' },
        team: { name: 'Engineering' },
        updatedAt: '2026-06-01T00:00:00.000Z',
        url: 'https://linear.app/x/issue/ENG-1',
      },
    ];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_issues', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({ nodes });

    const body = lastBody(fetcher);
    expect(body.query).toContain('issues(first: $first, filter: $filter)');
    expect(body.query).not.toContain('team(id:');
    expect(body.variables).toEqual({ first: 10 });
  });

  it('forwards state and assignee as an IssueFilter', async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    await runner.run(
      {
        id: 'c1',
        name: 'linear_list_issues',
        arguments: { state: 'In Progress', assignee: 'Ada' },
      },
      new AbortController().signal
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain('issues(first: $first, filter: $filter)');
    expect(body.variables).toEqual({
      first: 10,
      filter: {
        state: { name: { eqIgnoreCase: 'In Progress' } },
        assignee: { name: { eqIgnoreCase: 'Ada' } },
      },
    });
  });

  it('scopes to a team and caps first at 100', async () => {
    const nodes = [{ id: 'uuid-1', identifier: 'ENG-1' }];
    const fetcher = makeFetchStub({ data: { team: { issues: { nodes } } } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_issues', arguments: { teamId: 'team-uuid', first: 500 } },
      new AbortController().signal
    );

    expect(JSON.parse(String(result.content))).toEqual({ nodes });
    const body = lastBody(fetcher);
    expect(body.query).toContain('team(id: $teamId)');
    expect(body.variables).toEqual({ teamId: 'team-uuid', first: 100 });
  });

  it('errors when the scoped team is not found', async () => {
    const fetcher = makeFetchStub({ data: { team: null } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_issues', arguments: { teamId: 'missing' } },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Linear team not found: missing');
  });

  it('falls back to default first when given an invalid value', async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    await runner.run(
      { id: 'c1', name: 'linear_list_issues', arguments: { first: -3 } },
      new AbortController().signal
    );

    expect(lastBody(fetcher).variables).toEqual({ first: 10 });
  });
});

describe('linear_get_issue handler', () => {
  it('fetches a single issue by identifier', async () => {
    const issue = {
      id: 'uuid-1',
      identifier: 'ENG-123',
      title: 'Ship it',
      description: 'details',
      state: { name: 'Done' },
      assignee: { name: 'Ada' },
      team: { name: 'Engineering' },
      priority: 2,
      url: 'https://linear.app/x/issue/ENG-123',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    const fetcher = makeFetchStub({ data: { issue } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_get_issue', arguments: { id: 'ENG-123' } },
      new AbortController().signal
    );

    expect(JSON.parse(String(result.content))).toEqual(issue);
    const body = lastBody(fetcher);
    expect(body.query).toContain('issue(id: $id)');
    expect(body.variables).toEqual({ id: 'ENG-123' });
  });

  it('requires an id argument', async () => {
    const fetcher = makeFetchStub({ data: { issue: null } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_get_issue', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('id is required');
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it('errors when the issue is not found', async () => {
    const fetcher = makeFetchStub({ data: { issue: null } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_get_issue', arguments: { id: 'ENG-999' } },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Linear issue not found: ENG-999');
  });
});

describe('linear_list_teams and linear_list_users', () => {
  it('lists teams with default first', async () => {
    const nodes = [{ id: 't1', name: 'Engineering', key: 'ENG' }];
    const fetcher = makeFetchStub({ data: { teams: { nodes } } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_teams', arguments: {} },
      new AbortController().signal
    );

    expect(JSON.parse(String(result.content))).toEqual({ nodes });
    const body = lastBody(fetcher);
    expect(body.query).toContain('teams(first: $first)');
    expect(body.variables).toEqual({ first: 25 });
  });

  it('lists users with a custom first', async () => {
    const nodes = [{ id: 'u1', name: 'Ada', email: 'ada@x.com', active: true }];
    const fetcher = makeFetchStub({ data: { users: { nodes } } });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_users', arguments: { first: 10 } },
      new AbortController().signal
    );

    expect(JSON.parse(String(result.content))).toEqual({ nodes });
    const body = lastBody(fetcher);
    expect(body.query).toContain('users(first: $first)');
    expect(body.variables).toEqual({ first: 10 });
  });
});

describe('error handling', () => {
  it('surfaces GraphQL errors arrays', async () => {
    const fetcher = makeFetchStub({ errors: [{ message: 'Invalid filter' }] });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_issues', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Linear GraphQL error: Invalid filter');
  });

  it('surfaces non-ok HTTP responses with a JSON message', async () => {
    const fetcher = makeFetchStub({ message: 'Authentication required' }, 401);
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_issues', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Linear API error: 401 Authentication required');
  });

  it('uses HTTP status text when the error body is empty', async () => {
    const fetcher: LinearFetch = mock(() =>
      Promise.resolve(new Response('', { status: 502, statusText: 'Bad Gateway' }))
    );
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_teams', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Linear API error: 502 Bad Gateway');
  });

  it('errors when the response is missing data', async () => {
    const fetcher = makeFetchStub({ notData: {} });
    const runner = createToolRunner(createLinearTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'c1', name: 'linear_list_users', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Linear response is missing data');
  });
});

describe('LINEAR_HUB_TOOLS', () => {
  it('builds each tool from resolved credentials with the linear provider', () => {
    for (const [name, entry] of Object.entries(LINEAR_HUB_TOOLS)) {
      expect(entry.providerName).toBe('linear');
      expect(entry.definition.name).toBe(name);
      const tools = entry.createTools({ apiKey: 'k', baseURL: 'https://api.linear.app/graphql' });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.definition.name).toBe(name);
    }
  });

  it('builds tools when baseURL is empty by falling back to the default endpoint', () => {
    const tools = LINEAR_HUB_TOOLS.linear_list_issues.createTools({ apiKey: 'k', baseURL: '' });
    expect(tools).toHaveLength(1);
  });
});
