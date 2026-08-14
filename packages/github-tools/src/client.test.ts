import { expect, test } from "bun:test";

import { searchGitHubActivity } from "./client";

const REPOS = {
  items: [
    {
      full_name: "acme/agentkit",
      html_url: "https://github.com/acme/agentkit",
      description: "An agent toolkit",
      stargazers_count: 42,
      pushed_at: "2026-08-01T00:00:00Z",
    },
  ],
};

const ISSUES = {
  items: [
    {
      html_url: "https://github.com/acme/agentkit/issues/1",
      title: "Add streaming support",
      comments: 3,
      reactions: { total_count: 5 },
      updated_at: "2026-08-02T00:00:00Z",
    },
  ],
};

const PRS = {
  items: [
    {
      html_url: "https://github.com/acme/agentkit/pull/2",
      title: "Fix flaky test",
      comments: 1,
      reactions: { total_count: 0 },
      updated_at: "2026-08-03T00:00:00Z",
    },
  ],
};

function threeCallFetch(bodies: readonly unknown[]) {
  let call = 0;
  const captured: string[] = [];
  const fetchImpl = (async (input: URL | string) => {
    captured.push(String(input));
    const body = bodies[call];
    call += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

test("merges repos, issues, and PRs into one normalized list", async () => {
  const { fetchImpl } = threeCallFetch([REPOS, ISSUES, PRS]);
  const items = await searchGitHubActivity(
    { fetchImpl },
    { query: "agent workflows" },
  );
  expect(items).toEqual([
    {
      url: "https://github.com/acme/agentkit",
      title: "acme/agentkit: An agent toolkit",
      publishedAt: "2026-08-01T00:00:00Z",
      source: "github",
      engagement: { stars: 42 },
      entityTag: "acme/agentkit",
    },
    {
      url: "https://github.com/acme/agentkit/issues/1",
      title: "Add streaming support",
      publishedAt: "2026-08-02T00:00:00Z",
      source: "github",
      engagement: { upvotes: 5, comments: 3 },
    },
    {
      url: "https://github.com/acme/agentkit/pull/2",
      title: "Fix flaky test",
      publishedAt: "2026-08-03T00:00:00Z",
      source: "github",
      engagement: { upvotes: 0, comments: 1 },
    },
  ]);
});

test("omits the authorization header when no apiKey is given (keyless call)", async () => {
  const captured: (Record<string, string> | undefined)[] = [];
  const fetchImpl = (async (_input: URL | string, init?: RequestInit) => {
    captured.push(init?.headers as Record<string, string> | undefined);
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await searchGitHubActivity({ fetchImpl }, { query: "topic" });
  for (const headers of captured) {
    expect(headers?.authorization).toBeUndefined();
  }
});

test("sends a bearer authorization header when an apiKey is given", async () => {
  const captured: (Record<string, string> | undefined)[] = [];
  const fetchImpl = (async (_input: URL | string, init?: RequestInit) => {
    captured.push(init?.headers as Record<string, string> | undefined);
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await searchGitHubActivity(
    { apiKey: "ghp_test", fetchImpl },
    { query: "topic" },
  );
  for (const headers of captured) {
    expect(headers?.authorization).toBe("Bearer ghp_test");
  }
});

test("scopes each query with the days cutoff and per_page limit", async () => {
  const { fetchImpl, captured } = threeCallFetch([
    { items: [] },
    { items: [] },
    { items: [] },
  ]);
  await searchGitHubActivity(
    { fetchImpl },
    { query: "vector db", days: 7, limit: 3 },
  );
  expect(captured[0]).toContain("search/repositories");
  expect(captured[0]).toContain("per_page=3");
  expect(captured[1]).toContain("is%3Aissue");
  expect(captured[2]).toContain("is%3Apr");
});

test("throws on a non-ok HTTP response from any of the three calls", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 403 })) as unknown as typeof fetch;
  await expect(
    searchGitHubActivity({ fetchImpl }, { query: "topic" }),
  ).rejects.toThrow(/403/);
});

test("throws when a response body does not match the expected shape", async () => {
  const { fetchImpl } = threeCallFetch([
    { items: [{ bad: true }] },
    ISSUES,
    PRS,
  ]);
  await expect(
    searchGitHubActivity({ fetchImpl }, { query: "topic" }),
  ).rejects.toThrow(/did not match the expected shape/);
});
