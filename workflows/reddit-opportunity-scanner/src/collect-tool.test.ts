import { describe, expect, it, mock } from "bun:test";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import {
  REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION,
  createRedditOpportunityScannerCollectTools,
} from "./collect-tool";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function findTool(
  env: Parameters<typeof createRedditOpportunityScannerCollectTools>[0],
) {
  const tool = createRedditOpportunityScannerCollectTools(env).find(
    (t) =>
      t.definition.name ===
      REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION.name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(
      "reddit_opportunity_scanner_collect_searches not registered",
    );
  }
  return tool;
}

describe("reddit_opportunity_scanner_collect_searches", () => {
  it("returns a completed error envelope per search (not a throw) when ScrapeCreators is unconfigured", async () => {
    const env = {} as unknown as Parameters<
      typeof createRedditOpportunityScannerCollectTools
    >[0];
    const tool = findTool(env);
    const result = await tool.handler(
      {
        id: "call_1",
        name: tool.definition.name,
        arguments: {
          searches: [{ subreddit: "devops", query: "observability" }],
        },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    const content = result.content as { results: unknown[] };
    expect(content.results.length).toBe(1);
    expect(content.results[0]).toMatchObject({ isError: true });
  });

  it("returns a completed error envelope for a failed search without failing the other searches", async () => {
    const env = {
      [toolCredentialEnvKey("scrapecreators")]: {
        apiKey: "sc-key",
        baseURL: "",
      },
    } as unknown as Parameters<
      typeof createRedditOpportunityScannerCollectTools
    >[0];
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = mock(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(new Response("upstream error", { status: 502 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ posts: [] }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    try {
      const tool = findTool(env);
      const result = await tool.handler(
        {
          id: "call_2",
          name: tool.definition.name,
          arguments: {
            searches: [
              { subreddit: "devops", query: "dead search" },
              { subreddit: "sre", query: "observability" },
            ],
          },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      const content = result.content as { results: unknown[] };
      expect(content.results.length).toBe(2);
      expect(content.results[0]).toMatchObject({ isError: true });
      expect(typeof content.results[1]).toBe("string");
      expect(JSON.parse(content.results[1] as string)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes through the real (JSON-string) content on a successful search", async () => {
    const env = {
      [toolCredentialEnvKey("scrapecreators")]: {
        apiKey: "sc-key",
        baseURL: "",
      },
    } as unknown as Parameters<
      typeof createRedditOpportunityScannerCollectTools
    >[0];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ posts: [] }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    try {
      const tool = findTool(env);
      const result = await tool.handler(
        {
          id: "call_3",
          name: tool.definition.name,
          arguments: {
            searches: [{ subreddit: "devops", query: "observability" }],
          },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      const content = result.content as { results: unknown[] };
      expect(content.results.length).toBe(1);
      expect(typeof content.results[0]).toBe("string");
      expect(JSON.parse(content.results[0] as string)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when searches is not an array (a wiring bug, not a tolerated search failure)", async () => {
    const env = {} as unknown as Parameters<
      typeof createRedditOpportunityScannerCollectTools
    >[0];
    const tool = findTool(env);
    await expect(
      tool.handler(
        { id: "call_4", name: tool.definition.name, arguments: {} },
        SIGNAL,
      ),
    ).rejects.toThrow("searches must be an array");
  });
});

describe("tool-manifest", () => {
  it("registers the collect wrapper tool under its own factory", () => {
    const factory = toolManifestFile.factories.find(
      (f) =>
        f.factoryId ===
        "@workbench/workflow-reddit-opportunity-scanner/collect",
    );
    expect(factory?.bareToolNames).toEqual([
      REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION.name,
    ]);
  });
});
