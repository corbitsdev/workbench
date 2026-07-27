import { describe, expect, it } from "bun:test";
import { createExaTopicWatchTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function prepareSearchTool() {
  const tool = createExaTopicWatchTools().find(
    (t) => t.definition.name === "exa_topic_watch_prepare_search",
  );
  if (!tool || tool.kind !== "full") {
    throw new Error("prepare-search tool not registered as a full tool");
  }
  return tool;
}

describe("exa_topic_watch_prepare_search", () => {
  it("renames the intake topic to exa_search's query argument", async () => {
    const tool = prepareSearchTool();
    const result = await tool.handler(
      {
        id: "call_1",
        name: "exa_topic_watch_prepare_search",
        arguments: { topic: "AI coding agents for GTM" },
      },
      SIGNAL,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({ query: "AI coding agents for GTM" });
  });

  it("trims surrounding whitespace on the renamed query", async () => {
    const tool = prepareSearchTool();
    const result = await tool.handler(
      {
        id: "call_2",
        name: "exa_topic_watch_prepare_search",
        arguments: { topic: "  spaced topic  " },
      },
      SIGNAL,
    );

    expect(result.content).toEqual({ query: "spaced topic" });
  });

  it("errors when topic is missing", async () => {
    const tool = prepareSearchTool();
    const result = await tool.handler(
      {
        id: "call_3",
        name: "exa_topic_watch_prepare_search",
        arguments: {},
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("topic is required");
  });

  it("errors when topic is blank", async () => {
    const tool = prepareSearchTool();
    const result = await tool.handler(
      {
        id: "call_4",
        name: "exa_topic_watch_prepare_search",
        arguments: { topic: "   " },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
  });

  it("falls back to the _raw JSON envelope", async () => {
    const tool = prepareSearchTool();
    const result = await tool.handler(
      {
        id: "call_5",
        name: "exa_topic_watch_prepare_search",
        arguments: { _raw: JSON.stringify({ topic: "raw topic" }) },
      },
      SIGNAL,
    );

    expect(result.content).toEqual({ query: "raw topic" });
  });
});

describe("tool-manifest", () => {
  it("registers exa_topic_watch_prepare_search under the exa-topic-watch factory", () => {
    const factory = toolManifestFile.factories[0];
    expect(factory?.factoryId).toBe("@workbench/workflow-exa-topic-watch/core");
    expect(factory?.bareToolNames).toEqual(["exa_topic_watch_prepare_search"]);
  });
});
