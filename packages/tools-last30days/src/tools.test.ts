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

// Titled on-topic for the "AI Coding Agents" intake used by the resilience
// tests, so the item is grounded (clears the brief's relevance floor) and the
// tests isolate source-skipping behavior, not relevance filtering.
function validItemsEnvelope(): { output: { content: string } } {
  const items = [
    {
      url: "https://a.com",
      title: "Alpha post about AI coding agents",
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
  // Two on-topic Anthropic items that cover DIFFERENT stories (low entity
  // overlap), so they stay in separate clusters and the floor judges each on its
  // own rerank score rather than merging and sharing fate. The rerank test then
  // layers explicit LLM scores on top.
  const twoHnItems = {
    output: {
      content: JSON.stringify([
        {
          url: "https://a.com",
          title: "Anthropic funding round goes viral",
          publishedAt: "2026-06-20T12:00:00Z",
          source: "hn",
          engagement: { upvotes: 5000, comments: 400 },
        },
        {
          url: "https://b.com",
          title: "Quiet Anthropic safety research note",
          publishedAt: "2026-06-20T12:00:00Z",
          source: "hn",
          engagement: { upvotes: 5, comments: 1 },
        },
      ]),
    },
  };

  test("applies LLM rerank scores by url; a below-floor score is dropped", async () => {
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
    // b (95) leads; a (5) is below the brief's relevance floor and is cut
    // entirely rather than merely ranked last.
    expect(report.items.map((i) => i.url)).toEqual(["https://b.com"]);
    expect(report.items.find((i) => i.url === "https://b.com")?.relevance).toBe(
      95,
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

  test("floor + degraded rerank: lexically-ungrounded items are cut (documents the trade-off)", async () => {
    // When the rerank reply is malformed the brief falls back to deterministic
    // grounding against the RAW topic tokens. A lexically-grounded item survives;
    // a relevant-but-lexically-thin item scores below the floor and is cut even
    // when popular. This is the floor's intended trade-off (honest-small over
    // padded-noise); soften it by lowering BRIEF_MIN_RELEVANCE if ever needed.
    const report = await runBrief({
      intake: { output: { topic: "neobank launches", days: 30 } },
      hackernews: {
        output: {
          content: JSON.stringify([
            {
              url: "https://on.com",
              title: "A new neobank launches in Europe",
              publishedAt: "2026-06-20T12:00:00Z",
              source: "hn",
              engagement: { upvotes: 100, comments: 10 },
            },
            {
              url: "https://off.com",
              title: "Chime raises a megaround",
              publishedAt: "2026-06-20T12:00:00Z",
              source: "hn",
              engagement: { upvotes: 5000, comments: 400 },
            },
          ]),
        },
      },
      rerank: { output: { reply: "no json here" } },
    });
    const urls = report.items.map((i) => i.url);
    expect(urls).toContain("https://on.com");
    expect(urls).not.toContain("https://off.com");
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
        title: "Valid AI coding agents item",
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

  test("folds a polymarket source into the brief", async () => {
    const report = await runBrief({
      intake: { output: { topic: "election odds", days: 30 } },
      polymarket: {
        output: {
          content: JSON.stringify([
            {
              url: "https://polymarket.com/event/election-odds",
              title: "Election odds market",
              publishedAt: "2026-06-20T12:00:00Z",
              source: "polymarket",
              engagement: { upvotes: 100, comments: 0 },
            },
          ]),
        },
      },
    });
    expect(report.items.map((i) => i.source)).toContain("polymarket");
  });
});

function groundQueriesTool() {
  const tool = createLast30daysTools().find(
    (t) => t.definition.name === "last30days_ground_queries",
  );
  if (!tool || tool.kind !== "full") {
    throw new Error("ground-queries tool not registered as a full tool");
  }
  return tool.handler;
}

async function runGround(
  args: Record<string, unknown>,
): Promise<Record<string, string>> {
  const handler = groundQueriesTool();
  const result = await handler(
    { id: "c1", name: "x", arguments: args },
    SIGNAL,
  );
  if (typeof result.content === "string") {
    throw new Error("expected object content, got a string");
  }
  return result.content as Record<string, string>;
}

const SOURCE_KEYS = [
  "hackernews",
  "github",
  "web",
  "reddit",
  "x",
  "youtube",
  "polymarket",
] as const;

describe("last30days_ground_queries", () => {
  test("parses a clean reply into per-source tailored queries", async () => {
    const reply = JSON.stringify({
      hackernews: "hn query",
      github: "org/repo",
      web: "web query",
      reddit: "r/subreddit terms",
      x: "@handle cashtag",
      youtube: "video title phrasing",
      polymarket: "market framing",
    });
    const content = await runGround({ topic: "a topic", query: "base", reply });
    expect(content.github).toBe("org/repo");
    expect(content.youtube).toBe("video title phrasing");
    for (const key of SOURCE_KEYS) {
      expect(content[key]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("a missing or malformed reply falls every source back to the base query", async () => {
    const content = await runGround({
      topic: "a topic",
      query: "the base query",
      reply: "sorry, no JSON here",
    });
    for (const key of SOURCE_KEYS) {
      expect(content[key]).toBe("the base query");
    }
  });

  test("a partial reply tailors present keys and falls back the rest", async () => {
    const content = await runGround({
      topic: "a topic",
      query: "base",
      reply: JSON.stringify({ github: "org/repo", reddit: "  " }),
    });
    expect(content.github).toBe("org/repo");
    // blank value is ignored → fallback
    expect(content.reddit).toBe("base");
    expect(content.web).toBe("base");
  });

  test("falls back to the topic when no focus query is given", async () => {
    const content = await runGround({ topic: "the topic", reply: "{}" });
    expect(content.hackernews).toBe("the topic");
  });

  test("throws when neither query nor topic is present", async () => {
    await expect(runGround({ reply: "{}" })).rejects.toThrow(/query or topic/);
  });
});
