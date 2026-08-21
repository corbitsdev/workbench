// Proves the actual path Scout uses for web research: the real
// `@corbits/web-search-tools` bundle pinned by `SCOUT_TOOL_PACKAGE_PINS`,
// not a stand-in. This is the red/green pair the port was asked to
// demonstrate: a research question answered through the Exa-backed
// `web_search` tool with the search stubbed, and a missing credential
// surfacing an honest "not connected" result rather than failing
// silently or fabricating results.
import { describe, expect, test } from "bun:test";
import { WEB_SEARCH_TOOL, webSearchTools } from "@corbits/web-search-tools";
import type { WebSearchEnv } from "@corbits/web-search-tools";
import { SCOUT_TOOL_PACKAGE_PINS } from "../src/definition";

describe("Scout's web-research path (@corbits/web-search-tools)", () => {
  test("SCOUT_TOOL_PACKAGE_PINS pins the package this test exercises", () => {
    expect(SCOUT_TOOL_PACKAGE_PINS).toContainEqual({
      name: "@corbits/web-search-tools",
      version: "0.0.3",
    });
  });

  test("answers a research question when the Exa search is connected (stubbed)", async () => {
    const stubbedFetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Acme Corp raises Series B",
              url: "https://example.com/acme-series-b",
              publishedDate: "2026-08-01T00:00:00Z",
            },
          ],
        }),
      )) as unknown as typeof fetch;

    const env: WebSearchEnv = {
      credentials: {
        resolve: async () => ({ kind: "http", fetch: stubbedFetch }),
      },
    } as unknown as WebSearchEnv;

    const bundle = webSearchTools(env);
    const result = await bundle.run(
      {
        id: "call_1",
        name: WEB_SEARCH_TOOL,
        arguments: { query: "Acme Corp funding" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(String(result.content)) as {
      results: { title: string; url: string }[];
    };
    expect(parsed.results[0]?.title).toBe("Acme Corp raises Series B");
  });

  test("surfaces a connect prompt instead of failing silently when Exa isn't connected", async () => {
    const env: WebSearchEnv = {
      credentials: undefined,
    } as unknown as WebSearchEnv;

    const bundle = webSearchTools(env);
    const result = await bundle.run(
      {
        id: "call_2",
        name: WEB_SEARCH_TOOL,
        arguments: { query: "Acme Corp funding" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Web search is not connected for this user.");
  });
});
