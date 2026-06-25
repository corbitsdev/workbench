import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createScrapeCreatorsTools, SCRAPECREATORS_HUB_TOOLS } from "./tools";

function runTool(
  name: string,
  args: Record<string, unknown>,
  fetcher: ScrapeCreatorsFetchMock,
) {
  const runner = createToolRunner(
    createScrapeCreatorsTools({ apiKey: "test-api-key", fetcher }),
  );
  return runner.run(
    { id: `call_${name}`, name, arguments: args },
    new AbortController().signal,
  );
}

type ScrapeCreatorsFetchMock = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

describe("SCRAPECREATORS_HUB_TOOLS", () => {
  it("exports all four tools with providerName scrapecreators", () => {
    const keys = Object.keys(
      SCRAPECREATORS_HUB_TOOLS,
    ) as (keyof typeof SCRAPECREATORS_HUB_TOOLS)[];
    expect(keys).toEqual([
      "scrapecreators_tiktok",
      "scrapecreators_instagram",
      "scrapecreators_threads",
      "scrapecreators_pinterest",
    ]);

    for (const key of keys) {
      expect(SCRAPECREATORS_HUB_TOOLS[key].providerName).toBe("scrapecreators");
    }
  });

  it("each entry definition name matches its key", () => {
    for (const [key, entry] of Object.entries(SCRAPECREATORS_HUB_TOOLS)) {
      expect(entry.definition.name).toBe(key);
    }
  });

  it("createTools returns all four tools", () => {
    const tools = SCRAPECREATORS_HUB_TOOLS.scrapecreators_tiktok.createTools({
      apiKey: "test-key",
    });
    expect(tools.map((t) => t.definition.name)).toEqual([
      "scrapecreators_tiktok",
      "scrapecreators_instagram",
      "scrapecreators_threads",
      "scrapecreators_pinterest",
    ]);
  });
});

describe("scrapecreators_tiktok happy path", () => {
  it("hits the keyword endpoint and parses aweme_info items", async () => {
    const fetcher = mock(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/tiktok/search/keyword");
      expect(url.searchParams.get("query")).toBe("product launch");
      expect(url.searchParams.get("sort_by")).toBe("relevance");
      expect((init?.headers as Record<string, string>)?.["x-api-key"]).toBe(
        "test-api-key",
      );

      return new Response(
        JSON.stringify({
          search_item_list: [
            {
              aweme_info: {
                aweme_id: "vid_001",
                share_url: "https://www.tiktok.com/@creator/video/vid_001",
                desc: "Exciting product launch video",
                create_time: 1700000000,
                statistics: { digg_count: 1500, comment_count: 42 },
                author: { unique_id: "creator_handle" },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await runTool(
      "scrapecreators_tiktok",
      { query: "product launch" },
      fetcher,
    );
    expect(result.isError).toBeUndefined();

    const items = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >[];
    expect(items).toHaveLength(1);

    const item = items[0] as Record<string, unknown>;
    expect(item["url"]).toBe("https://www.tiktok.com/@creator/video/vid_001");
    expect(item["title"]).toBe("Exciting product launch video");
    expect(item["author"]).toBe("creator_handle");
    expect(item["source"]).toBe("tiktok");
    expect((item["engagement"] as Record<string, unknown>)["upvotes"]).toBe(
      1500,
    );
    expect((item["engagement"] as Record<string, unknown>)["comments"]).toBe(
      42,
    );
    expect(item["publishedAt"]).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("surfaces API errors with the response body", async () => {
    const fetcher = mock(
      async () =>
        new Response('{"error":"invalid api key"}', {
          status: 403,
          statusText: "Forbidden",
        }),
    );

    const result = await runTool(
      "scrapecreators_tiktok",
      { query: "test" },
      fetcher,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("403");
    expect(result.content).toContain("invalid api key");
  });

  it("throws when query is missing", async () => {
    const fetcher = mock(async () => new Response("{}", { status: 200 }));
    const result = await runTool("scrapecreators_tiktok", {}, fetcher);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  });
});

describe("result limit", () => {
  function buildTikTokItems(count: number): unknown[] {
    return Array.from({ length: count }, (_, i) => ({
      aweme_info: {
        aweme_id: `vid_${i}`,
        share_url: `https://www.tiktok.com/@creator/video/vid_${i}`,
        desc: `video ${i}`,
      },
    }));
  }

  it("caps results at the default of 10 when no limit is given", async () => {
    const fetcher = mock(
      async () =>
        new Response(
          JSON.stringify({ search_item_list: buildTikTokItems(25) }),
          { status: 200 },
        ),
    );
    const result = await runTool(
      "scrapecreators_tiktok",
      { query: "q" },
      fetcher,
    );
    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(10);
  });

  it("clamps an explicit limit above the max to 100", async () => {
    const fetcher = mock(
      async () =>
        new Response(
          JSON.stringify({ search_item_list: buildTikTokItems(150) }),
          { status: 200 },
        ),
    );
    const result = await runTool(
      "scrapecreators_tiktok",
      { query: "q", limit: 500 },
      fetcher,
    );
    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(100);
  });

  it("honors an explicit limit within range", async () => {
    const fetcher = mock(
      async () =>
        new Response(
          JSON.stringify({ search_item_list: buildTikTokItems(25) }),
          { status: 200 },
        ),
    );
    const result = await runTool(
      "scrapecreators_tiktok",
      { query: "q", limit: 5 },
      fetcher,
    );
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(5);
  });
});

describe("scrapecreators_instagram happy path", () => {
  it("hits the reels search endpoint and parses reels", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v2/instagram/reels/search");
      expect(url.searchParams.get("query")).toBe("skincare");

      return new Response(
        JSON.stringify({
          reels: [
            {
              code: "ABC123",
              caption: { text: "Morning skincare routine" },
              taken_at: 1700100000,
              like_count: 800,
              comment_count: 12,
              user: { username: "brandaccount" },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await runTool(
      "scrapecreators_instagram",
      { query: "skincare" },
      fetcher,
    );
    const items = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >[];
    expect(items).toHaveLength(1);

    const item = items[0] as Record<string, unknown>;
    expect(item["url"]).toBe("https://www.instagram.com/reel/ABC123");
    expect(item["title"]).toBe("Morning skincare routine");
    expect(item["author"]).toBe("brandaccount");
    expect(item["source"]).toBe("instagram");
    expect((item["engagement"] as Record<string, unknown>)["upvotes"]).toBe(
      800,
    );
    expect(item["publishedAt"]).toBe(new Date(1700100000 * 1000).toISOString());
  });

  it("reads top-level reel fields and returns empty for an unknown response shape", async () => {
    const fetcher = mock(
      async () =>
        new Response(JSON.stringify({ unexpected: [{ code: "NOPE" }] }), {
          status: 200,
        }),
    );
    const result = await runTool(
      "scrapecreators_instagram",
      { query: "skincare" },
      fetcher,
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toHaveLength(0);
  });
});

describe("scrapecreators_threads happy path", () => {
  it("hits the threads search endpoint and tolerates alternate response keys", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/threads/search");
      expect(url.searchParams.get("query")).toBe("ai agents");

      return new Response(
        JSON.stringify({
          search_results: [
            {
              code: "Abc1DefG",
              text: "Short threads post",
              taken_at: 1700100000,
              like_count: 55,
              user: { username: "threaduser" },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await runTool(
      "scrapecreators_threads",
      { query: "ai agents" },
      fetcher,
    );
    const items = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >[];
    expect(items).toHaveLength(1);

    const item = items[0] as Record<string, unknown>;
    expect(item["url"]).toBe("https://www.threads.net/t/Abc1DefG");
    expect(item["author"]).toBe("threaduser");
    expect(item["source"]).toBe("threads");
  });
});

describe("scrapecreators_pinterest happy path", () => {
  it("hits the pinterest search endpoint and parses pins", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/pinterest/search");
      expect(url.searchParams.get("query")).toBe("recipes");

      return new Response(
        JSON.stringify({
          pins: [
            {
              id: "pin_789",
              title: "Beautiful Recipe",
              description: "A detailed recipe description",
              created_at: "2024-10-01T08:00:00Z",
              save_count: 320,
              pinner: { username: "pinner_user" },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await runTool(
      "scrapecreators_pinterest",
      { query: "recipes" },
      fetcher,
    );
    const items = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >[];
    expect(items).toHaveLength(1);

    const item = items[0] as Record<string, unknown>;
    expect(item["url"]).toBe("https://pinterest.com/pin/pin_789");
    expect(item["author"]).toBe("pinner_user");
    expect(item["source"]).toBe("pinterest");
    expect((item["engagement"] as Record<string, unknown>)["upvotes"]).toBe(
      320,
    );
  });
});
