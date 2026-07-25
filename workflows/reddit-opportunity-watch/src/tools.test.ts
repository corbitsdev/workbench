import { describe, expect, test } from "bun:test";
import { createRedditOpportunityWatchTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function fullTool(name: string) {
  const tool = createRedditOpportunityWatchTools().find(
    (t) => t.definition.name === name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool.handler;
}

describe("reddit_opportunity_watch_format_digest_document", () => {
  test("pairs query and reply into a title/body document", async () => {
    const handler = fullTool("reddit_opportunity_watch_format_digest_document");
    const result = await handler(
      {
        id: "document",
        name: "reddit_opportunity_watch_format_digest_document",
        arguments: {
          query: "devops hiring",
          reply: "## Digest\n\nThree threads look like opportunities.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "devops hiring",
      body: "## Digest\n\nThree threads look like opportunities.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("reddit_opportunity_watch_format_digest_document");
    const result = await handler(
      {
        id: "document",
        name: "reddit_opportunity_watch_format_digest_document",
        arguments: { query: "devops hiring" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  test("returns isError when query is missing", async () => {
    const handler = fullTool("reddit_opportunity_watch_format_digest_document");
    const result = await handler(
      {
        id: "document",
        name: "reddit_opportunity_watch_format_digest_document",
        arguments: { reply: "body" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("query is required");
  });
});

describe("tool-manifest completeness", () => {
  test("every registered tool name is declared in the hand-authored manifest", () => {
    const runtimeNames = createRedditOpportunityWatchTools()
      .map((tool) => tool.definition.name)
      .sort();
    const factory = toolManifestFile.factories[0];
    if (!factory) {
      throw new Error(
        "expected the reddit-opportunity-watch manifest to declare a factory",
      );
    }
    const manifestNames = [...factory.bareToolNames].sort();
    expect(manifestNames).toEqual(runtimeNames);
  });
});
