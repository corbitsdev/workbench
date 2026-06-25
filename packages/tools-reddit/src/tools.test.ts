import { describe, expect, it } from "bun:test";
import { REDDIT_HUB_TOOLS, createRedditTools } from "./tools";

// /v1/reddit/search shape: epoch created_utc, string subreddit, ups.
const SEARCH_RESPONSE = {
  success: true,
  posts: [
    {
      id: "xyz789",
      title: "Test Reddit Post",
      url: "https://example.com/external-link",
      permalink: "/r/programming/comments/xyz789/test_reddit_post/",
      selftext: "body text",
      created_utc: 1700100000,
      ups: 100,
      score: 100,
      num_comments: 10,
      subreddit: "programming",
    },
  ],
  after: "t3_xyz789",
};

// /v1/reddit/subreddit/search shape: ISO created_at, nested subreddit object, votes.
const SUBREDDIT_RESPONSE = {
  posts: [
    {
      id: "abc123",
      title: "Rust thread",
      permalink: "/r/rust/comments/abc123/rust_thread/",
      votes: 250,
      num_comments: 42,
      created_at: "2023-11-16T00:00:00.000Z",
      subreddit: { name: "rust" },
    },
  ],
  cursor: "c_abc123",
};

type CapturedRequest = { url: string; init: RequestInit | undefined };

function makeCapturingFetcher(response: unknown, captured: CapturedRequest[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    captured.push({ url, init });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function getHandler(tools: ReturnType<typeof createRedditTools>, name: string) {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return (
    tool as {
      handler: (a: Record<string, unknown>, s: AbortSignal) => Promise<string>;
    }
  ).handler;
}

describe("REDDIT_HUB_TOOLS", () => {
  it("exposes both reddit tool keys", () => {
    expect("reddit_search" in REDDIT_HUB_TOOLS).toBe(true);
    expect("reddit_subreddit_search" in REDDIT_HUB_TOOLS).toBe(true);
  });

  it("resolves both tools through the scrapecreators credential provider", () => {
    expect(REDDIT_HUB_TOOLS.reddit_search.providerName).toBe("scrapecreators");
    expect(REDDIT_HUB_TOOLS.reddit_subreddit_search.providerName).toBe(
      "scrapecreators",
    );
  });
});

describe("top comment extraction", () => {
  it("surfaces top comments from the post payload as research-item topComments", async () => {
    const response = {
      posts: [
        {
          id: "fun1",
          title: "Funny thread",
          permalink: "/r/funny/comments/fun1/funny_thread/",
          created_utc: 1700100000,
          ups: 100,
          num_comments: 10,
          subreddit: "funny",
          top_comments: [
            { body: "where is the limewire link", author: "u/ace", ups: 1338 },
          ],
        },
      ],
    };
    const handler = getHandler(
      createRedditTools({
        apiKey: "k",
        fetcher: async () => new Response(JSON.stringify(response)),
      }),
      "reddit_search",
    );
    const items = JSON.parse(
      await handler({ query: "funny" }, new AbortController().signal),
    );
    expect(items[0].topComments[0].text).toBe("where is the limewire link");
    expect(items[0].topComments[0].score).toBe(1338);
    expect(items[0].topComments[0].author).toBe("u/ace");
  });

  it("omits topComments when the payload carries none", async () => {
    const handler = getHandler(
      createRedditTools({
        apiKey: "k",
        fetcher: async () => new Response(JSON.stringify(SEARCH_RESPONSE)),
      }),
      "reddit_search",
    );
    const items = JSON.parse(
      await handler({ query: "x" }, new AbortController().signal),
    );
    expect("topComments" in items[0]).toBe(false);
  });
});

describe("reddit_search", () => {
  it("calls the ScrapeCreators reddit search endpoint with the api key header", async () => {
    const captured: CapturedRequest[] = [];
    const tools = createRedditTools({
      apiKey: "sc-key",
      fetcher: makeCapturingFetcher(SEARCH_RESPONSE, captured),
    });
    const raw = await getHandler(tools, "reddit_search")(
      { query: "typescript", timeframe: "week" },
      new AbortController().signal,
    );

    const request = captured[0];
    expect(request).toBeDefined();
    const url = new URL(request!.url);
    expect(url.pathname).toBe("/v1/reddit/search");
    expect(url.searchParams.get("query")).toBe("typescript");
    expect(url.searchParams.get("timeframe")).toBe("week");
    const headers = new Headers(request!.init?.headers);
    expect(headers.get("x-api-key")).toBe("sc-key");

    const items = JSON.parse(raw) as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const item = items[0]!;
    // permalink (the reddit thread), not the external url field
    expect(item.url).toBe(
      "https://www.reddit.com/r/programming/comments/xyz789/test_reddit_post/",
    );
    expect(item.title).toBe("Test Reddit Post");
    expect(item.source).toBe("reddit");
    expect(item.publishedAt).toBe("2023-11-16T02:00:00.000Z");
    expect(item.author).toBe("r/programming");
    const engagement = item.engagement as Record<string, unknown>;
    expect(engagement.upvotes).toBe(100);
    expect(engagement.comments).toBe(10);
  });

  it("requires a query", async () => {
    const tools = createRedditTools({
      apiKey: "sc-key",
      fetcher: async () => new Response("{}"),
    });
    await expect(
      getHandler(tools, "reddit_search")({}, new AbortController().signal),
    ).rejects.toThrow("reddit_search:");
  });
});

describe("reddit_subreddit_search", () => {
  it("calls the subreddit search endpoint and normalizes the votes/created_at/nested-subreddit shape", async () => {
    const captured: CapturedRequest[] = [];
    const tools = createRedditTools({
      apiKey: "sc-key",
      fetcher: makeCapturingFetcher(SUBREDDIT_RESPONSE, captured),
    });
    const raw = await getHandler(tools, "reddit_subreddit_search")(
      { subreddit: "rust", query: "async" },
      new AbortController().signal,
    );

    const url = new URL(captured[0]!.url);
    expect(url.pathname).toBe("/v1/reddit/subreddit/search");
    expect(url.searchParams.get("subreddit")).toBe("rust");
    expect(url.searchParams.get("query")).toBe("async");

    const items = JSON.parse(raw) as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.source).toBe("reddit");
    expect(item.author).toBe("r/rust");
    expect(item.publishedAt).toBe("2023-11-16T00:00:00.000Z");
    const engagement = item.engagement as Record<string, unknown>;
    expect(engagement.upvotes).toBe(250);
    expect(engagement.comments).toBe(42);
  });

  it("requires a subreddit", async () => {
    const tools = createRedditTools({
      apiKey: "sc-key",
      fetcher: async () => new Response("{}"),
    });
    await expect(
      getHandler(tools, "reddit_subreddit_search")(
        { query: "x" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("reddit_subreddit_search:");
  });
});

describe("limit handling", () => {
  function manyPosts(count: number) {
    return {
      posts: Array.from({ length: count }, (_, i) => ({
        id: `p${i}`,
        title: `Post ${i}`,
        permalink: `/r/rust/comments/p${i}/post_${i}/`,
        created_utc: 1700100000 + i,
        ups: 1,
        num_comments: 0,
        subreddit: "rust",
      })),
    };
  }

  it("caps results at the default of 10 when no limit is given", async () => {
    const handler = getHandler(
      createRedditTools({
        apiKey: "k",
        fetcher: async () => new Response(JSON.stringify(manyPosts(25))),
      }),
      "reddit_search",
    );
    const items = JSON.parse(
      await handler({ query: "rust" }, new AbortController().signal),
    ) as unknown[];
    expect(items).toHaveLength(10);
  });

  it("clamps an explicit limit to the MAX of 100", async () => {
    const handler = getHandler(
      createRedditTools({
        apiKey: "k",
        fetcher: async () => new Response(JSON.stringify(manyPosts(150))),
      }),
      "reddit_search",
    );
    const items = JSON.parse(
      await handler(
        { query: "rust", limit: 500 },
        new AbortController().signal,
      ),
    ) as unknown[];
    expect(items).toHaveLength(100);
  });
});

describe("malformed posts", () => {
  it("skips posts missing a permalink or a resolvable date instead of emitting garbage", async () => {
    const response = {
      posts: [
        {
          id: "good",
          title: "Usable",
          permalink: "/r/rust/comments/good/usable/",
          created_utc: 1700100000,
          ups: 5,
          num_comments: 1,
          subreddit: "rust",
        },
        {
          id: "no-permalink",
          title: "No link",
          created_utc: 1700100000,
          subreddit: "rust",
        },
        {
          id: "no-date",
          title: "No date",
          permalink: "/r/rust/comments/no-date/no_date/",
          subreddit: "rust",
        },
      ],
    };
    const tools = createRedditTools({
      apiKey: "sc-key",
      fetcher: async () => new Response(JSON.stringify(response)),
    });
    const raw = await getHandler(tools, "reddit_search")(
      { query: "rust" },
      new AbortController().signal,
    );
    const items = JSON.parse(raw) as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe(
      "https://www.reddit.com/r/rust/comments/good/usable/",
    );
  });
});

describe("error handling", () => {
  it("throws a ScrapeCreators error on a non-ok response", async () => {
    const tools = createRedditTools({
      apiKey: "sc-key",
      fetcher: async () =>
        new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        }),
    });
    await expect(
      getHandler(tools, "reddit_search")(
        { query: "x" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("ScrapeCreators API error: 429");
  });
});
