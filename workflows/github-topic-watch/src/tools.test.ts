import { describe, expect, test } from "bun:test";
import { createGithubTopicWatchTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function fullTool(name: string) {
  const tool = createGithubTopicWatchTools().find(
    (t) => t.definition.name === name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool.handler;
}

describe("github_topic_watch_format_activity_query", () => {
  test("renames topic to query and stamps a fixed 7-day lookback", async () => {
    const handler = fullTool("github_topic_watch_format_activity_query");
    const result = await handler(
      {
        id: "format-query",
        name: "github_topic_watch_format_activity_query",
        arguments: { topic: "AI coding agents" },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({ query: "AI coding agents", days: 7 });
  });

  test("trims whitespace around topic", async () => {
    const handler = fullTool("github_topic_watch_format_activity_query");
    const result = await handler(
      {
        id: "format-query",
        name: "github_topic_watch_format_activity_query",
        arguments: { topic: "  AI coding agents  " },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({ query: "AI coding agents", days: 7 });
  });

  test("returns isError when topic is missing", async () => {
    const handler = fullTool("github_topic_watch_format_activity_query");
    const result = await handler(
      {
        id: "format-query",
        name: "github_topic_watch_format_activity_query",
        arguments: {},
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("topic is required");
  });

  test("returns isError when topic is blank", async () => {
    const handler = fullTool("github_topic_watch_format_activity_query");
    const result = await handler(
      {
        id: "format-query",
        name: "github_topic_watch_format_activity_query",
        arguments: { topic: "   " },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("topic is required");
  });
});

describe("tool-manifest completeness", () => {
  test("every registered tool name is declared in the hand-authored manifest", () => {
    const runtimeNames = createGithubTopicWatchTools()
      .map((tool) => tool.definition.name)
      .sort();
    const factory = toolManifestFile.factories[0];
    if (!factory) {
      throw new Error(
        "expected the github-topic-watch manifest to declare a factory",
      );
    }
    const manifestNames = [...factory.bareToolNames].sort();
    expect(manifestNames).toEqual(runtimeNames);
  });
});
