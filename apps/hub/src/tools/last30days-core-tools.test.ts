import { describe, expect, it } from "bun:test";
import type { StringToolHandler } from "@intx/agent";
import { Report } from "@workbench/last30days-core";
import type { ResearchItem } from "@workbench/last30days-core";
import { LAST30DAYS_CORE_HUB_TOOLS } from "./last30days-core-tools";

const SIGNAL = new AbortController().signal;

// biome-ignore lint/suspicious/noExplicitAny: test mock context
const STUB_CONTEXT: any = {
  db: {},
  tenantId: "tn-1",
  principalId: "prn-1",
  agentId: "agt-1",
  sessionId: "sess-1",
};

function getStringHandler(toolName: string): StringToolHandler {
  const entry = LAST30DAYS_CORE_HUB_TOOLS[toolName];
  if (!entry) throw new Error(`Tool not found: ${toolName}`);
  const tools = entry.createTools(STUB_CONTEXT);
  const tool = tools[0];
  if (!tool) throw new Error(`No tool instance for: ${toolName}`);
  if (tool.kind !== "string")
    throw new Error(`Expected string tool: ${toolName}`);
  return tool.handler;
}

describe("last30days_core_extract", () => {
  it("extracts subreddits and handles from a topic string", async () => {
    const handler = getStringHandler("last30days_core_extract");
    const resultJson = await handler(
      { topic: "r/rust @openai latest news" },
      SIGNAL,
    );
    const result = JSON.parse(resultJson);
    expect(result.subreddits).toContain("rust");
    expect(result.handles).toContain("openai");
  });

  it("recovers topic from _raw fallback object", async () => {
    const handler = getStringHandler("last30days_core_extract");
    const rawArgs = JSON.stringify({ topic: "rust async" });
    const result = JSON.parse(await handler({ _raw: rawArgs }, SIGNAL));
    expect(typeof result).toBe("object");
  });

  it("throws a clear error when _raw is invalid JSON", async () => {
    const handler = getStringHandler("last30days_core_extract");
    await expect(handler({ _raw: "not-json" }, SIGNAL)).rejects.toThrow();
  });
});

describe("last30days_core_report", () => {
  it("returns a valid Report shape for a small fixture", async () => {
    const handler = getStringHandler("last30days_core_report");

    const nowIso = new Date().toISOString();
    const item: ResearchItem = {
      url: "https://example.com/article",
      title: "Test Article",
      publishedAt: nowIso,
      source: "web",
      engagement: { upvotes: 10, comments: 2 },
    };

    const resultJson = await handler(
      {
        rawItems: [item],
        topic: "test topic",
        days: 30,
        topK: 20,
      },
      SIGNAL,
    );

    const result = JSON.parse(resultJson);
    const validated = Report(result);
    expect("summary" in validated).toBe(false);
    expect(result.topic).toBe("test topic");
    expect(result.days).toBe(30);
    expect(Array.isArray(result.items)).toBe(true);
    expect(Array.isArray(result.citations)).toBe(true);
    expect(typeof result.generatedAt).toBe("string");
  });

  it("applies default days=30 when not provided", async () => {
    const handler = getStringHandler("last30days_core_report");
    const nowIso = new Date().toISOString();
    const item: ResearchItem = {
      url: "https://example.com/b",
      title: "Another Article",
      publishedAt: nowIso,
      source: "hn",
      engagement: { upvotes: 5, comments: 1 },
    };

    const resultJson = await handler(
      { rawItems: [item], topic: "defaults test" },
      SIGNAL,
    );
    const result = JSON.parse(resultJson);
    expect(result.days).toBe(30);
  });

  it("recovers topic and rawItems from _raw fallback", async () => {
    const handler = getStringHandler("last30days_core_report");
    const nowIso = new Date().toISOString();
    const item = {
      url: "https://example.com/raw",
      title: "Raw Item",
      publishedAt: nowIso,
      source: "web",
      engagement: { upvotes: 5, comments: 1 },
    };
    const rawArgs = JSON.stringify({ topic: "raw test", rawItems: [item] });
    const resultJson = await handler({ _raw: rawArgs }, SIGNAL);
    const result = JSON.parse(resultJson);
    expect(result.topic).toBe("raw test");
  });

  it("recovers when rawItems is a stringified array", async () => {
    const handler = getStringHandler("last30days_core_report");
    const nowIso = new Date().toISOString();
    const item = {
      url: "https://example.com/str",
      title: "Stringified Item",
      publishedAt: nowIso,
      source: "hn",
      engagement: { upvotes: 3, comments: 0 },
    };
    const resultJson = await handler(
      { topic: "str test", rawItems: JSON.stringify([item]) },
      SIGNAL,
    );
    const result = JSON.parse(resultJson);
    expect(result.topic).toBe("str test");
  });
});

describe("last30days_validate", () => {
  it("always returns { ok: true } regardless of input", async () => {
    const handler = getStringHandler("last30days_validate");
    const resultJson = await handler(
      {
        body: "some report body",
        citations: [
          { url: "https://x.com", source: "web", retrievedAt: "2026-01-01" },
        ],
        returnedItemUrls: ["https://x.com"],
      },
      SIGNAL,
    );
    const result = JSON.parse(resultJson);
    expect(result.ok).toBe(true);
  });

  it("returns the body string in the response", async () => {
    const handler = getStringHandler("last30days_validate");
    const resultJson = await handler(
      {
        body: "hello",
        citations: [],
        returnedItemUrls: [],
      },
      SIGNAL,
    );
    const result = JSON.parse(resultJson);
    expect(result.body).toBe("hello");
  });
});
