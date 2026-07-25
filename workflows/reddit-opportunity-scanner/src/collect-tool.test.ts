import { describe, expect, it, mock } from "bun:test";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import {
  REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCH_DEFINITION,
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
      REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCH_DEFINITION.name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error("reddit_opportunity_scanner_collect_search not registered");
  }
  return tool;
}

describe("reddit_opportunity_scanner_collect_search", () => {
  it("returns a completed error envelope (not a throw) when ScrapeCreators is unconfigured", async () => {
    const env = {} as unknown as Parameters<
      typeof createRedditOpportunityScannerCollectTools
    >[0];
    const tool = findTool(env);
    const result = await tool.handler(
      {
        id: "call_1",
        name: tool.definition.name,
        arguments: { subreddit: "devops", query: "observability" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({ isError: true });
  });

  it("returns a completed error envelope (not a throw) when the search call fails", async () => {
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
      Promise.resolve(new Response("upstream error", { status: 502 })),
    ) as unknown as typeof fetch;
    try {
      const tool = findTool(env);
      const result = await tool.handler(
        {
          id: "call_2",
          name: tool.definition.name,
          arguments: { subreddit: "devops", query: "observability" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toMatchObject({ isError: true });
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
          arguments: { subreddit: "devops", query: "observability" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(typeof result.content).toBe("string");
      expect(JSON.parse(result.content as string)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
      REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCH_DEFINITION.name,
    ]);
  });
});
