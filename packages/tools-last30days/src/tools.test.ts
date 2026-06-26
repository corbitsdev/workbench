import { describe, expect, test } from "bun:test";
import { type Report, parseReport } from "@workbench/last30days-core";
import { createLast30daysTools } from "./tools";

type StringHandler = (
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<string>;

function workflowBriefHandler(): StringHandler {
  const tool = createLast30daysTools().find(
    (t) => t.definition.name === "last30days_workflow_brief",
  );
  if (!tool || tool.kind !== "string") {
    throw new Error("workflow brief tool not registered as a string tool");
  }
  return tool.handler;
}

function validItemsEnvelope(): { output: { content: string } } {
  const items = [
    {
      url: "https://a.com",
      title: "Alpha post about TypeScript",
      publishedAt: "2026-06-20T12:00:00Z",
      source: "hn",
      engagement: { upvotes: 200, comments: 40 },
    },
  ];
  return { output: { content: JSON.stringify(items) } };
}

const SIGNAL = new AbortController().signal;

async function runBrief(steps: Record<string, unknown>): Promise<Report> {
  const handler = workflowBriefHandler();
  const raw = await handler(steps, SIGNAL);
  const parsed = parseReport(JSON.parse(raw));
  if (!parsed) throw new Error("handler returned a non-Report payload");
  return parsed;
}

describe("last30days_workflow_brief rerank (W1.2)", () => {
  const twoHnItems = {
    output: {
      content: JSON.stringify([
        {
          url: "https://a.com",
          title: "Unrelated viral post",
          publishedAt: "2026-06-20T12:00:00Z",
          source: "hn",
          engagement: { upvotes: 5000, comments: 400 },
        },
        {
          url: "https://b.com",
          title: "Quiet note",
          publishedAt: "2026-06-20T12:00:00Z",
          source: "hn",
          engagement: { upvotes: 5, comments: 1 },
        },
      ]),
    },
  };

  test("applies LLM rerank scores by url and they dominate ranking", async () => {
    const report = await runBrief({
      intake: { output: { topic: "Anthropic", days: 30 } },
      hackernews: twoHnItems,
      rerank: {
        output: {
          reply:
            'Here you go:\n{"scores":[{"url":"https://a.com","relevance":5},{"url":"https://b.com","relevance":95}]}',
        },
      },
    });
    expect(report.items[0]?.url).toBe("https://b.com");
    expect(report.items.find((i) => i.url === "https://b.com")?.relevance).toBe(
      95,
    );
    expect(report.items.find((i) => i.url === "https://a.com")?.relevance).toBe(
      5,
    );
  });

  test("a malformed rerank reply is ignored; ranking falls back to deterministic", async () => {
    const report = await runBrief({
      intake: { output: { topic: "Anthropic", days: 30 } },
      hackernews: twoHnItems,
      rerank: { output: { reply: "sorry, I could not produce JSON" } },
    });
    expect(report.items.length).toBe(2);
    // Deterministic grounding does not write the relevance field onto items.
    expect(report.items.every((i) => i.relevance === undefined)).toBe(true);
  });
});

describe("last30days_workflow_brief resilience", () => {
  test("one errored source does not poison the brief — good sources still produce items", async () => {
    const report = await runBrief({
      intake: { output: { topic: "AI Coding Agents", days: 30 } },
      hackernews: validItemsEnvelope(),
      x: {
        output: {
          content: "xAI API error: 429 Too Many Requests",
          isError: true,
        },
      },
    });
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.skippedSources?.map((s) => s.source)).toContain("x");
  });

  test("a non-JSON content envelope is skipped, not thrown", async () => {
    const report = await runBrief({
      intake: { output: { topic: "AI Coding Agents", days: 30 } },
      hackernews: validItemsEnvelope(),
      reddit: { output: { content: "<html>rate limited</html>" } },
    });
    expect(report.items.length).toBeGreaterThan(0);
    const reddit = report.skippedSources?.find((s) => s.source === "reddit");
    if (!reddit) throw new Error("expected reddit to be recorded as skipped");
    expect(reddit.reason).toContain("non-JSON");
  });

  test("every source failing yields an empty-but-valid brief that names the skips", async () => {
    const report = await runBrief({
      intake: { output: { topic: "AI Coding Agents", days: 30 } },
      hackernews: { output: { content: "boom", isError: true } },
      reddit: { output: { content: "boom", isError: true } },
    });
    expect(report.items).toHaveLength(0);
    expect(report.skippedSources?.map((s) => s.source).sort()).toEqual([
      "hackernews",
      "reddit",
    ]);
  });

  test("a source returning a JSON array with a malformed item keeps the valid items and records the drop", async () => {
    const mixed = [
      {
        url: "https://good.com",
        title: "Valid item",
        publishedAt: "2026-06-20T12:00:00Z",
        source: "reddit",
        engagement: { upvotes: 10, comments: 2 },
      },
      { url: "https://bad.com", title: "missing publishedAt and source" },
    ];
    const report = await runBrief({
      intake: { output: { topic: "AI Coding Agents", days: 30 } },
      reddit: { output: { content: JSON.stringify(mixed) } },
    });
    expect(report.items.map((i) => i.url)).toEqual(["https://good.com"]);
    const itemsSkip = report.skippedSources?.find(
      (s) => s.source === "reddit" && s.kind === "invalid-items",
    );
    if (!itemsSkip) throw new Error("expected an item-validation skip entry");
    expect(itemsSkip.reason).toContain("failed schema validation");
  });

  test("a long source error reason is truncated to keep the brief bounded", async () => {
    const huge = `xAI API error: 500 ${"x".repeat(5000)}`;
    const report = await runBrief({
      intake: { output: { topic: "AI Coding Agents", days: 30 } },
      hackernews: validItemsEnvelope(),
      x: { output: { content: huge, isError: true } },
    });
    const xSkip = report.skippedSources?.find((s) => s.source === "x");
    if (!xSkip) throw new Error("expected x to be recorded as skipped");
    expect(xSkip.kind).toBe("source-error");
    expect(xSkip.reason.length).toBeLessThan(huge.length);
    expect(xSkip.reason).toContain("chars)");
  });

  test("still requires an intake topic", async () => {
    const handler = workflowBriefHandler();
    await expect(
      handler({ hackernews: validItemsEnvelope() }, SIGNAL),
    ).rejects.toThrow(/topic/);
  });
});
