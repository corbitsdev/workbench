import { describe, expect, mock, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { type } from "arktype";
import { ResearchItem } from "@workbench/last30days-core";
import { createGitHubTools, type GitHubFetch } from "./tools";

const recentDate = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
const staleDate = new Date(Date.now() - 60 * 86400 * 1000).toISOString();

const mockReposResponse = {
  items: [
    {
      full_name: "acme/cool-repo",
      html_url: "https://github.com/acme/cool-repo",
      description: "A cool repository",
      stargazers_count: 5000,
      pushed_at: recentDate,
    },
  ],
};

const mockIssuesResponse = {
  items: [
    {
      html_url: "https://github.com/acme/cool-repo/issues/12",
      title: "Feature request: add streaming",
      comments: 8,
      reactions: { total_count: 20 },
      updated_at: recentDate,
    },
  ],
};

const mockPRsResponse = {
  items: [
    {
      html_url: "https://github.com/acme/cool-repo/pull/99",
      title: "Add feature X",
      comments: 3,
      reactions: { total_count: 15 },
      updated_at: recentDate,
    },
  ],
};

function makeGitHubFetcher(
  reposResponse: unknown,
  issuesResponse: unknown,
  prsResponse: unknown,
  status = 200,
): GitHubFetch {
  return mock((url: string, _init?: RequestInit) => {
    let body: unknown;
    if (url.includes("/search/repositories")) {
      body = reposResponse;
    } else if (url.includes("is%3Aissue") || url.includes("is:issue")) {
      body = issuesResponse;
    } else {
      body = prsResponse;
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        statusText: status === 200 ? "OK" : "Error",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

describe("github_activity tool", () => {
  test("returns normalized ResearchItems from repos, issues, and PRs", async () => {
    const fetcher = makeGitHubFetcher(
      mockReposResponse,
      mockIssuesResponse,
      mockPRsResponse,
    );
    const runner = createToolRunner(
      createGitHubTools({ apiKey: "test-token", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "github_activity",
        arguments: { query: "AI agents" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(3);

    for (const item of items) {
      const validation = ResearchItem(item);
      expect(validation instanceof type.errors).toBe(false);
    }

    const repoItem = items[0] as Record<string, unknown>;
    expect(repoItem.source).toBe("github");
    expect(repoItem.entityTag).toBe("acme/cool-repo");
  });

  test("issue item carries comment count in engagement", async () => {
    const fetcher = makeGitHubFetcher({ items: [] }, mockIssuesResponse, {
      items: [],
    });
    const runner = createToolRunner(
      createGitHubTools({ apiKey: "test-token", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_2",
        name: "github_activity",
        arguments: { query: "streaming" },
      },
      new AbortController().signal,
    );

    const items = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >[];
    const issue = items[0];
    expect(issue).toBeDefined();
    const engagement = issue?.engagement as Record<string, unknown>;
    expect(engagement?.comments).toBe(8);
    expect(engagement?.upvotes).toBe(20);
  });

  test("publishedAt uses updated_at for issues and PRs", async () => {
    const fetcher = makeGitHubFetcher({ items: [] }, mockIssuesResponse, {
      items: [],
    });
    const runner = createToolRunner(
      createGitHubTools({ apiKey: "test-token", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_3",
        name: "github_activity",
        arguments: { query: "streaming" },
      },
      new AbortController().signal,
    );

    const items = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >[];
    expect(items[0]?.publishedAt).toBe(recentDate);
  });

  test("drops items whose publishedAt is outside the requested window", async () => {
    const staleIssuesResponse = {
      items: [
        {
          html_url: "https://github.com/acme/old-repo/issues/1",
          title: "Ancient issue",
          comments: 0,
          reactions: { total_count: 0 },
          updated_at: staleDate,
        },
      ],
    };
    const fetcher = makeGitHubFetcher({ items: [] }, staleIssuesResponse, {
      items: [],
    });
    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));

    const result = await runner.run(
      {
        id: "call_4",
        name: "github_activity",
        arguments: { query: "old topic", days: 30 },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(0);
  });

  test("uses is:pr qualifier, not type:pr, in PR search URL", async () => {
    const calls: string[] = [];
    const fetcher: GitHubFetch = mock((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    });

    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));
    await runner.run(
      { id: "call_5", name: "github_activity", arguments: { query: "test" } },
      new AbortController().signal,
    );

    const prUrl = calls.find(
      (u) => u.includes("is%3Apr") || u.includes("is:pr"),
    );
    expect(prUrl).toBeDefined();
    const issueUrl = calls.find(
      (u) => u.includes("is%3Aissue") || u.includes("is:issue"),
    );
    expect(issueUrl).toBeDefined();
    const brokenUrl = calls.find(
      (u) => u.includes("type%3Apr") || u.includes("type:pr"),
    );
    expect(brokenUrl).toBeUndefined();
  });

  test("uses updated:>= qualifier for issues and PRs", async () => {
    const calls: string[] = [];
    const fetcher: GitHubFetch = mock((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    });

    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));
    await runner.run(
      { id: "call_6", name: "github_activity", arguments: { query: "test" } },
      new AbortController().signal,
    );

    const issueOrPrUrls = calls.filter((u) => u.includes("/search/issues"));
    for (const url of issueOrPrUrls) {
      expect(url).toContain("updated%3A%3E%3D");
    }
  });

  test("defaults per_page to 5 on each of the three search URLs", async () => {
    const calls: string[] = [];
    const fetcher: GitHubFetch = mock((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    });

    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));
    await runner.run(
      {
        id: "call_limit_1",
        name: "github_activity",
        arguments: { query: "test" },
      },
      new AbortController().signal,
    );

    expect(calls).toHaveLength(3);
    for (const url of calls) {
      expect(new URL(url).searchParams.get("per_page")).toBe("5");
    }
  });

  test("forwards an explicit limit to per_page on every search URL", async () => {
    const calls: string[] = [];
    const fetcher: GitHubFetch = mock((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    });

    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));
    await runner.run(
      {
        id: "call_limit_2",
        name: "github_activity",
        arguments: { query: "test", limit: 12 },
      },
      new AbortController().signal,
    );

    expect(calls).toHaveLength(3);
    for (const url of calls) {
      expect(new URL(url).searchParams.get("per_page")).toBe("12");
    }
  });

  test("clamps an over-max limit to 25", async () => {
    const calls: string[] = [];
    const fetcher: GitHubFetch = mock((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    });

    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));
    await runner.run(
      {
        id: "call_limit_3",
        name: "github_activity",
        arguments: { query: "test", limit: 999 },
      },
      new AbortController().signal,
    );

    expect(calls).toHaveLength(3);
    for (const url of calls) {
      expect(new URL(url).searchParams.get("per_page")).toBe("25");
    }
  });

  test("falls back to default per_page for an invalid limit", async () => {
    const calls: string[] = [];
    const fetcher: GitHubFetch = mock((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    });

    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));
    await runner.run(
      {
        id: "call_limit_4",
        name: "github_activity",
        arguments: { query: "test", limit: -3 },
      },
      new AbortController().signal,
    );

    expect(calls).toHaveLength(3);
    for (const url of calls) {
      expect(new URL(url).searchParams.get("per_page")).toBe("5");
    }
  });

  test("omits Authorization header when apiKey is empty", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher: GitHubFetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    });

    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));
    await runner.run(
      { id: "call_7", name: "github_activity", arguments: { query: "test" } },
      new AbortController().signal,
    );

    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    const headers = firstCall?.init?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  test("returns empty array when no items", async () => {
    const fetcher = makeGitHubFetcher(
      { items: [] },
      { items: [] },
      { items: [] },
    );
    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));

    const result = await runner.run(
      {
        id: "call_8",
        name: "github_activity",
        arguments: { query: "obscure" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(0);
  });

  test("surfaces HTTP error as tool error", async () => {
    const fetcher: GitHubFetch = mock(() =>
      Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
    );
    const runner = createToolRunner(
      createGitHubTools({ apiKey: "bad", fetcher }),
    );

    const result = await runner.run(
      { id: "call_9", name: "github_activity", arguments: { query: "AI" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("GitHub API error: 401");
  });

  test("includes GitHub error body in error message for non-ok responses", async () => {
    const errorBody = {
      message: "Validation Failed",
      errors: [{ code: "invalid", field: "q", resource: "Search" }],
    };
    const fetcher: GitHubFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(errorBody), {
          status: 422,
          statusText: "Unprocessable Entity",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const runner = createToolRunner(
      createGitHubTools({ apiKey: "test", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_10",
        name: "github_activity",
        arguments: { query: "AI agents" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("422");
    expect(String(result.content)).toContain("Validation Failed");
  });

  test("surfaces missing query as tool error", async () => {
    const fetcher = makeGitHubFetcher(
      { items: [] },
      { items: [] },
      { items: [] },
    );
    const runner = createToolRunner(createGitHubTools({ apiKey: "", fetcher }));

    const result = await runner.run(
      { id: "call_11", name: "github_activity", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("query is required");
  });
});
