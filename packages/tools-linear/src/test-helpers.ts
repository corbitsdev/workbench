import { mock } from "bun:test";
import { expect } from "bun:test";
import type { LinearFetch } from "./shared";

export type FetchStub = LinearFetch & {
  mock: { calls: [string, RequestInit][] };
};

export function makeFetchStub(response: unknown, status = 200): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

export type QueryRoute = {
  includes: string;
  data: Record<string, unknown>;
};

/** Stub fetch that picks `data` by the first matching query substring. */
export function makeRoutingFetchStub(routes: QueryRoute[]): FetchStub {
  return mock((_input: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const route = routes.find((r) => body.query.includes(r.includes));
    if (route === undefined) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            errors: [
              { message: `Unstubbed GraphQL: ${body.query.slice(0, 120)}` },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: route.data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

export function lastBody(
  fetcher: FetchStub,
  callIndex = 0,
): {
  query: string;
  variables: Record<string, unknown>;
} {
  const call = fetcher.mock.calls[callIndex];
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1].body));
}

export function asConnection(nodes: unknown[]) {
  return {
    nodes,
    pageInfo: { endCursor: null, hasNextPage: false },
  };
}
