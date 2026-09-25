import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools, LINEAR_HUB_TOOLS, type LinearFetch } from "./index";
import { listIssues } from "./issues";
import { asConnection, makeRoutingFetchStub } from "./test-helpers";

type FetchStub = LinearFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeFetchStub(response: unknown, status = 200): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function lastBody(fetcher: FetchStub): {
  query: string;
  variables: Record<string, unknown>;
} {
  const call = fetcher.mock.calls[0];
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1].body));
}

function asConnection(nodes: unknown[]) {
  return {
    nodes,
    pageInfo: { endCursor: null, hasNextPage: false },
  };
}

describe("createLinearTools", () => {
  it("exposes one tool per LINEAR_HUB_TOOLS entry", () => {
    const tools = createLinearTools({ apiKey: "test-key" });
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(Object.keys(LINEAR_HUB_TOOLS).sort());
  });

  it("throws when apiKey is empty", () => {
    expect(() => createLinearTools({ apiKey: "" })).toThrow(
      "Linear apiKey is required",
    );
  });

  it("throws when baseUrl is invalid", () => {
    expect(() =>
      createLinearTools({ apiKey: "test-key", baseUrl: "not-a-url" }),
    ).toThrow("Linear baseUrl must be a valid URL");
  });
});

describe("auth and endpoint", () => {
  it("sends the api key as a bare Authorization header against the default endpoint", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "secret-key", fetcher }),
    );

    await runner.run(
      { id: "c1", name: "linear_list_issues", arguments: {} },
      new AbortController().signal,
    );

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.linear.app/graphql");
    const headers = call?.[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("secret-key");
    expect(headers.Authorization).not.toContain("Bearer");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("uses an overridden baseUrl", async () => {
    const fetcher = makeFetchStub({ data: { teams: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({
        apiKey: "k",
        baseUrl: "https://proxy.test/gql",
        fetcher,
      }),
    );

    await runner.run(
      { id: "c1", name: "linear_list_teams", arguments: {} },
      new AbortController().signal,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://proxy.test/gql");
  });
});

describe("linear_list_issues handler", () => {
  it("lists workspace issues with default first and parses the response", async () => {
    const nodes = [
      {
        id: "uuid-1",
        identifier: "ENG-1",
        title: "Fix bug",
        state: { name: "In Progress" },
        assignee: { name: "Ada" },
        team: { name: "Engineering" },
        updatedAt: "2026-06-01T00:00:00.000Z",
        url: "https://linear.app/x/issue/ENG-1",
      },
    ];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_issues", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      ...asConnection(nodes),
      scope: {
        directFilters: null,
        teamScope: { teamId: null },
        savedView: { applied: false },
      },
    });

    const body = lastBody(fetcher);
    expect(body.query).toContain("issues(first:");
    expect(body.query).not.toContain("team(id:");
    expect(body.variables).toEqual({ first: 10 });
  });

  it("forwards state and assignee as an IssueFilter", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { state: "In Progress", assignee: "Ada" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("issues(first:");
    expect(body.variables).toEqual({
      first: 10,
      filter: {
        state: { name: { eqIgnoreCase: "In Progress" } },
        assignee: { name: { eqIgnoreCase: "Ada" } },
      },
    });
  });

  it("forwards updatedAfter as an IssueFilter updatedAt.gt bound", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { updatedAfter: "2026-07-04T00:00:00.000Z" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables).toEqual({
      first: 10,
      filter: { updatedAt: { gt: "2026-07-04T00:00:00.000Z" } },
    });
  });

  it("uses createdAfter as the updatedAt bound when updatedAfter is absent", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: {
          createdAfter: "2026-07-01T00:00:00.000Z",
          enabledSources: ["linear"],
        },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables).toEqual({
      first: 50,
      filter: { updatedAt: { gt: "2026-07-01T00:00:00.000Z" } },
      orderBy: "updatedAt",
    });
  });

  it("forwards createdAfter as an IssueFilter createdAt.gt bound for non-brief callers", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: {
          createdAfter: "2026-07-01T00:00:00.000Z",
        },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables).toEqual({
      first: 10,
      filter: { createdAt: { gt: "2026-07-01T00:00:00.000Z" } },
    });
  });

  it("accepts a hub-enriched heartbeat trigger payload (extra mail fields)", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: {
          reason: "manual-brief",
          userAddress: "usr_abc@workbench.local",
          userRefId: "usr_abc",
          enabledSources: ["linear"],
          createdAfter: "2026-07-01T00:00:00.000Z",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(result.content))).toEqual({
      newIssues: [],
      completedIssues: [],
      updatedIssues: nodes,
      scope: {
        directFilters: { updatedAt: { gt: "2026-07-01T00:00:00.000Z" } },
        teamScope: { teamId: null },
        savedView: { applied: false },
      },
    });
  });

  it("carries the Linear issue's url straight through brief-shaping (CL-3504)", async () => {
    const nodes = [
      {
        id: "uuid-1",
        identifier: "ENG-1",
        title: "Fix the thing",
        url: "https://linear.app/workbench/issue/ENG-1",
      },
    ];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["linear"] },
      },
      new AbortController().signal,
    );

    const parsed = JSON.parse(String(result.content));
    expect(parsed.updatedIssues[0].url).toBe(
      "https://linear.app/workbench/issue/ENG-1",
    );
  });

  it("skips the network call and reports skipped when linear is not in enabledSources", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["email"] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.content))).toEqual({ skipped: true });
  });

  it("wraps a brief-shaped call's issues under a source-unique key", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: {
          createdAfter: "2026-07-01T00:00:00.000Z",
          enabledSources: ["linear"],
        },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual({
      newIssues: [],
      completedIssues: [],
      updatedIssues: nodes,
      scope: {
        directFilters: { updatedAt: { gt: "2026-07-01T00:00:00.000Z" } },
        teamScope: { teamId: null },
        savedView: { applied: false },
      },
    });
  });

  it("returns a paginated connection for non-brief callers", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: {},
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual({
      ...asConnection(nodes),
      scope: {
        directFilters: null,
        teamScope: { teamId: null },
        savedView: { applied: false },
      },
    });
  });

  it("returns empty issues for brief-shaped calls when the connection is null", async () => {
    const fetcher = makeFetchStub({ data: { issues: null } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["linear"] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      newIssues: [],
      completedIssues: [],
      updatedIssues: [],
      scope: {
        directFilters: null,
        teamScope: { teamId: null },
        savedView: { applied: false },
      },
    });
  });

  it("forwards orderBy as a PaginationOrderBy scalar", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { orderBy: "updatedAt" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables.orderBy).toBe("updatedAt");
  });

  it("forces updatedAt ordering on brief-shaped calls with a cutoff (CL-4084)", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: {
          enabledSources: ["linear"],
          createdAfter: "2026-07-01T00:00:00.000Z",
        },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables.orderBy).toBe("updatedAt");
  });

  it("respects an explicit orderBy on brief-shaped calls instead of forcing updatedAt (CL-4084)", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: {
          enabledSources: ["linear"],
          createdAfter: "2026-07-01T00:00:00.000Z",
          orderBy: "createdAt",
        },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables.orderBy).toBe("createdAt");
  });

  it("does not force orderBy on brief-shaped calls without a cutoff (CL-4084)", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["linear"] },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables.orderBy).toBeUndefined();
  });

  it("widens the brief field selection to createdAt, completedAt, priority, state.type, project (CL-4084)", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["linear"] },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("createdAt");
    expect(body.query).toContain("completedAt");
    expect(body.query).toContain("priority");
    expect(body.query).toContain("state { name type }");
    expect(body.query).toContain("project { name }");
  });

  it("defaults brief-shaped calls to a page size of 50 (CL-4084)", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["linear"] },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables.first).toBe(50);
  });

  it("keeps the non-brief default page size at 10 (CL-4084)", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      { id: "c1", name: "linear_list_issues", arguments: {} },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.variables.first).toBe(10);
  });

  it("buckets brief-shaped issues into newIssues, completedIssues, updatedIssues by cutoff (CL-4084)", async () => {
    const cutoff = "2026-07-01T00:00:00.000Z";
    const nodes = [
      {
        id: "uuid-new",
        identifier: "ENG-1",
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
      },
      {
        id: "uuid-completed",
        identifier: "ENG-2",
        createdAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
      {
        id: "uuid-updated",
        identifier: "ENG-3",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      },
    ];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["linear"], updatedAfter: cutoff },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual({
      newIssues: [nodes[0]],
      completedIssues: [nodes[1]],
      updatedIssues: [nodes[2]],
      scope: {
        directFilters: { updatedAt: { gt: cutoff } },
        teamScope: { teamId: null },
        savedView: { applied: false },
      },
    });
  });

  it("buckets an issue created and completed inside the window as completed, not new (CL-4084)", async () => {
    const cutoff = "2026-07-01T00:00:00.000Z";
    const nodes = [
      {
        id: "uuid-quick-fix",
        identifier: "ENG-9",
        createdAt: "2026-07-05T00:00:00.000Z",
        completedAt: "2026-07-05T12:00:00.000Z",
        updatedAt: "2026-07-05T12:00:00.000Z",
      },
    ];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["linear"], updatedAfter: cutoff },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual({
      newIssues: [],
      completedIssues: [nodes[0]],
      updatedIssues: [],
      scope: {
        directFilters: { updatedAt: { gt: cutoff } },
        teamScope: { teamId: null },
        savedView: { applied: false },
      },
    });
  });

  it("scopes to a team and caps first at the issue list maximum", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = mock((_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("TeamByName")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { teams: { nodes: [{ id: "team-uuid" }] } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              team: {
                issues: {
                  nodes,
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as FetchStub;
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { teamId: "team-uuid", first: 500 },
      },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual({
      ...asConnection(nodes),
      scope: {
        directFilters: null,
        teamScope: { teamId: "team-uuid" },
        savedView: { applied: false },
      },
    });
    const lastCall = fetcher.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const body = JSON.parse(String(lastCall?.[1].body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("team(id: $teamId)");
    expect(body.variables).toEqual({ teamId: "team-uuid", first: 250 });
  });

  it("errors when the scoped team is not found", async () => {
    const fetcher = mock((_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("TeamByName")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { teams: { nodes: [] } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: { team: null } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as FetchStub;
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { teamId: "missing" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear team not found: missing");
  });

  it("forwards in-range priority on list filter and omits out-of-range", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { priority: 2 },
      },
      new AbortController().signal,
    );
    expect(lastBody(fetcher).variables.filter).toEqual({
      priority: { eq: 2 },
    });

    const fetcherOut = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runnerOut = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher: fetcherOut }),
    );
    await runnerOut.run(
      {
        id: "c2",
        name: "linear_list_issues",
        arguments: { priority: 9 },
      },
      new AbortController().signal,
    );
    expect(lastBody(fetcherOut).variables.filter).toBeUndefined();
    expect(lastBody(fetcherOut).variables).toEqual({ first: 10 });
  });

  it("omits negative and non-integer priority from list filter", async () => {
    for (const priority of [-1, 1.5, 5]) {
      const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
      const runner = createToolRunner(
        createLinearTools({ apiKey: "k", fetcher }),
      );
      await runner.run(
        {
          id: "c1",
          name: "linear_list_issues",
          arguments: { priority },
        },
        new AbortController().signal,
      );
      expect(lastBody(fetcher).variables).toEqual({ first: 10 });
    }
  });

  it("falls back to default first when given an invalid value", async () => {
    const fetcher = makeFetchStub({ data: { issues: { nodes: [] } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      { id: "c1", name: "linear_list_issues", arguments: { first: -3 } },
      new AbortController().signal,
    );

    expect(lastBody(fetcher).variables).toEqual({ first: 10 });
  });
});

describe("linear_list_issues scope metadata (CL-8907)", () => {
  it("echoes the effective direct filters in scope.directFilters", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { state: "In Progress", assignee: "Ada" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed.scope.directFilters).toEqual(
      lastBody(fetcher).variables.filter,
    );
    expect(parsed.scope.directFilters).toEqual({
      state: { name: { eqIgnoreCase: "In Progress" } },
      assignee: { name: { eqIgnoreCase: "Ada" } },
    });
  });

  it("reports null directFilters and an unapplied savedView when no filters are sent", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_issues", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      ...asConnection(nodes),
      scope: {
        directFilters: null,
        teamScope: { teamId: null },
        savedView: { applied: false },
      },
    });
  });

  it("carries identical scope on brief-shaped buckets with post-aliasing directFilters", async () => {
    const cutoff = "2026-07-01T00:00:00.000Z";
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { enabledSources: ["linear"], createdAfter: cutoff },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed.newIssues).toEqual([]);
    expect(parsed.completedIssues).toEqual([]);
    expect(parsed.updatedIssues).toEqual(nodes);
    expect(parsed.scope.directFilters).toEqual(
      lastBody(fetcher).variables.filter,
    );
    expect(parsed.scope.directFilters).toEqual({
      updatedAt: { gt: cutoff },
    });
    expect(parsed.scope.teamScope).toEqual({ teamId: null });
    expect(parsed.scope.savedView).toEqual({ applied: false });
  });

  it("reports the resolved team id in scope.teamScope on the team path", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeRoutingFetchStub([
      {
        includes: "TeamByName",
        data: { teams: { nodes: [{ id: "team-uuid" }] } },
      },
      {
        includes: "team(id: $teamId)",
        data: {
          team: {
            issues: {
              nodes,
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_list_issues",
        arguments: { teamId: "team-uuid" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed.nodes).toEqual(nodes);
    expect(parsed.scope).toEqual({
      directFilters: null,
      teamScope: { teamId: "team-uuid" },
      savedView: { applied: false },
    });
  });

  it("identifies the applied saved view by id and name on the connection branch", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });

    const result = await listIssues(
      { apiKey: "k", fetcher },
      {},
      new AbortController().signal,
      { savedView: { id: "view-123", name: "My Triage" } },
    );

    expect(result).toEqual({
      ...asConnection(nodes),
      scope: {
        directFilters: null,
        teamScope: { teamId: null },
        savedView: { applied: true, id: "view-123", name: "My Triage" },
      },
    });
  });

  it("carries the identical applied-view scope on brief-shaped buckets", async () => {
    const nodes = [{ id: "uuid-1", identifier: "ENG-1" }];
    const fetcher = makeFetchStub({ data: { issues: { nodes } } });

    const result = await listIssues(
      { apiKey: "k", fetcher },
      { enabledSources: ["linear"] },
      new AbortController().signal,
      { savedView: { id: "view-123", name: "My Triage" } },
    );

    expect(result).toEqual({
      newIssues: [],
      completedIssues: [],
      updatedIssues: nodes,
      scope: {
        directFilters: null,
        teamScope: { teamId: null },
        savedView: { applied: true, id: "view-123", name: "My Triage" },
      },
    });
  });
});

describe("linear_get_issue handler", () => {
  it("fetches a single issue by identifier", async () => {
    const issue = {
      id: "uuid-1",
      identifier: "ENG-123",
      title: "Ship it",
      description: "details",
      state: { name: "Done" },
      assignee: { name: "Ada" },
      team: { name: "Engineering" },
      priority: 2,
      url: "https://linear.app/x/issue/ENG-123",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const fetcher = makeFetchStub({ data: { issue } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_get_issue", arguments: { id: "ENG-123" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(issue);
    const body = lastBody(fetcher);
    expect(body.query).toContain("issue(id: $id)");
    expect(body.variables).toEqual({ id: "ENG-123" });
  });

  it("requires an id argument", async () => {
    const fetcher = makeFetchStub({ data: { issue: null } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_get_issue", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("linear_get_issue");
    expect(result.content).toContain("id");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("errors when the issue is not found", async () => {
    const fetcher = makeFetchStub({ data: { issue: null } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_get_issue", arguments: { id: "ENG-999" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear issue not found: ENG-999");
  });
});

describe("linear_list_teams and linear_list_users", () => {
  it("lists teams with default first", async () => {
    const nodes = [{ id: "t1", name: "Engineering", key: "ENG" }];
    const fetcher = makeFetchStub({ data: { teams: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_teams", arguments: {} },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("teams(first:");
    expect(body.variables).toEqual({ first: 25 });
  });

  it("lists users with a custom first", async () => {
    const nodes = [{ id: "u1", name: "Ada", email: "ada@x.com", active: true }];
    const fetcher = makeFetchStub({ data: { users: { nodes } } });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_users", arguments: { first: 10 } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    const body = lastBody(fetcher);
    expect(body.query).toContain("users(first:");
    expect(body.variables).toEqual({ first: 10 });
  });
});

describe("error handling", () => {
  it("surfaces GraphQL errors arrays", async () => {
    const fetcher = makeFetchStub({ errors: [{ message: "Invalid filter" }] });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_issues", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear GraphQL error: Invalid filter");
  });

  it("surfaces non-ok HTTP responses with a JSON message", async () => {
    const fetcher = makeFetchStub({ message: "Authentication required" }, 401);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_issues", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Linear API error: 401 Authentication required",
    );
  });

  it("uses HTTP status text when the error body is empty", async () => {
    const fetcher: LinearFetch = mock(() =>
      Promise.resolve(
        new Response("", { status: 502, statusText: "Bad Gateway" }),
      ),
    );
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_teams", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear API error: 502 Bad Gateway");
  });

  it("prefers HTTP body over statusText when both are present", async () => {
    const fetcher: LinearFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "upstream rate limited" }), {
          status: 502,
          statusText: "Bad Gateway",
        }),
      ),
    );
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_teams", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Linear API error: 502 upstream rate limited",
    );
    expect(result.content).not.toContain("Bad Gateway");
  });

  it("errors when the response is missing data", async () => {
    const fetcher = makeFetchStub({ notData: {} });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "c1", name: "linear_list_users", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Linear response is missing data");
  });
});

describe("linear_create_issue handler", () => {
  it("runs the issueCreate mutation with the input variables and parses the created issue", async () => {
    const issue = {
      id: "uuid-9",
      identifier: "ENG-9",
      title: "Ship the write tool",
      url: "https://linear.app/x/issue/ENG-9",
    };
    const fetcher = makeRoutingFetchStub([
      {
        includes: "TeamByName",
        data: { teams: { nodes: [{ id: "team-uuid" }] } },
      },
      {
        includes: "issueCreate",
        data: { issueCreate: { success: true, issue } },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_create_issue",
        arguments: {
          teamId: "team-uuid",
          title: "Ship the write tool",
          description: "with **markdown**",
          priority: 2,
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(issue);

    const lastCall = fetcher.mock.calls.at(-1);
    const body = JSON.parse(String(lastCall?.[1].body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("issueCreate(input: $input)");
    expect(body.variables).toEqual({
      input: {
        teamId: "team-uuid",
        title: "Ship the write tool",
        description: "with **markdown**",
        priority: 2,
      },
    });
  });

  it("omits optional fields when not provided", async () => {
    const issue = { id: "uuid-1", identifier: "ENG-1", title: "T", url: "u" };
    const fetcher = makeRoutingFetchStub([
      {
        includes: "TeamByName",
        data: { teams: { nodes: [{ id: "team-uuid" }] } },
      },
      {
        includes: "issueCreate",
        data: { issueCreate: { success: true, issue } },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "c1",
        name: "linear_create_issue",
        arguments: { teamId: "team-uuid", title: "T" },
      },
      new AbortController().signal,
    );

    const lastCall = fetcher.mock.calls.at(-1);
    const body = JSON.parse(String(lastCall?.[1].body)) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({
      input: { teamId: "team-uuid", title: "T" },
    });
  });

  it("requires a teamId", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_create_issue",
        arguments: { title: "T" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("linear_create_issue");
    expect(result.content).toContain("teamId");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("requires a title", async () => {
    const fetcher = makeFetchStub({ data: {} });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_create_issue",
        arguments: { teamId: "team-uuid" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("linear_create_issue");
    expect(result.content).toContain("title");
    expect(fetcher.mock.calls).toHaveLength(0);
  });

  it("errors when Linear rejects the create and returns no issue", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "TeamByName",
        data: { teams: { nodes: [{ id: "team-uuid" }] } },
      },
      {
        includes: "issueCreate",
        data: { issueCreate: { success: false, issue: null } },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      {
        id: "c1",
        name: "linear_create_issue",
        arguments: { teamId: "team-uuid", title: "T" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Linear did not return the issue from issueCreate",
    );
    expect(fetcher.mock.calls).toHaveLength(2);
  });
});

describe("LINEAR_HUB_TOOLS", () => {
  it("classifies linear_create_issue as write and linear_list_issues as read", () => {
    expect(LINEAR_HUB_TOOLS.linear_create_issue?.sideEffect).toBe("write");
    expect(LINEAR_HUB_TOOLS.linear_list_issues?.sideEffect).toBe("read");
  });

  it("classifies every write tool as write", () => {
    const writeNames = Object.keys(LINEAR_HUB_TOOLS).filter((name) =>
      /^(linear_(create|update|save|delete|archive|link|prepare))/.test(name),
    );
    for (const name of writeNames) {
      expect(LINEAR_HUB_TOOLS[name]?.sideEffect).toBe("write");
    }
  });

  it("builds each tool from resolved credentials with the linear provider", () => {
    for (const [name, entry] of Object.entries(LINEAR_HUB_TOOLS)) {
      expect(entry.providerName).toBe("linear");
      expect(entry.definition.name).toBe(name);
      const tools = entry.createTools({
        apiKey: "k",
        baseURL: "https://api.linear.app/graphql",
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.definition.name).toBe(name);
    }
  });

  it("builds tools when baseURL is empty by falling back to the default endpoint", () => {
    expect(LINEAR_HUB_TOOLS.linear_list_issues).toBeDefined();
    const tools = LINEAR_HUB_TOOLS.linear_list_issues!.createTools({
      apiKey: "k",
      baseURL: "",
    });
    expect(tools).toHaveLength(1);
  });
});
