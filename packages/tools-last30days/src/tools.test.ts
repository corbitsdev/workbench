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

// A clean collect-step pool of three neobank items: two that belong to a launch
// theme and one promo/junk item the curate model should drop. Dates are recent so
// they survive the date window.
function collectStep(): { output: { content: unknown } } {
  return {
    output: {
      content: {
        topic: "Neobank Launches",
        days: 30,
        items: [
          {
            url: "https://prnewswire.com/coverd",
            title: "Neobank Coverd launches a gamified credit card",
            publishedAt: "2026-06-18T12:00:00Z",
            source: "web",
          },
          {
            url: "https://reddit.com/r/biltrewards/coverd",
            title:
              "...and y'all think BILT credit is complicated - check 'Coverd'",
            publishedAt: "2026-06-18T12:00:00Z",
            source: "reddit",
            author: "u/biltfan",
            engagement: { upvotes: 81, comments: 34 },
          },
          {
            url: "https://youtube.com/watch?v=shill",
            title: "I made $5000 with this CRYPTO BANK token!!! 🚀🚀",
            publishedAt: "2026-06-20T12:00:00Z",
            source: "youtube",
            engagement: { views: 12, upvotes: 0 },
          },
        ],
      },
    },
  };
}

function curateStep(reply: string): { output: { reply: string } } {
  return { output: { reply } };
}

describe("last30days_workflow_brief curation (CL-2503)", () => {
  test("groups items into named themes, drops the un-themed junk, and emits the selected quote", async () => {
    const reply = JSON.stringify({
      themes: [
        {
          title: "Coverd's gamified credit card draws skepticism",
          summary: "a16z-backed Coverd launches; Reddit pushes back.",
          itemUrls: [
            "https://prnewswire.com/coverd",
            "https://reddit.com/r/biltrewards/coverd",
          ],
        },
      ],
      quotes: [
        {
          quote:
            "...and y'all think BILT credit is complicated - check 'Coverd'",
          author: "u/biltfan",
          source: "reddit",
          engagement: 81,
          url: "https://reddit.com/r/biltrewards/coverd",
        },
      ],
    });
    const report = await runBrief({
      intake: { output: { topic: "Neobank Launches", days: 30 } },
      collect: collectStep(),
      curate: curateStep(reply),
    });

    // The named theme survives with both its items; the YouTube $TOKEN shill the
    // model left out of every theme is dropped from the report entirely.
    expect(report.clusters.map((c) => c.title)).toEqual([
      "Coverd's gamified credit card draws skepticism",
    ]);
    expect(report.clusters[0]?.items.map((i) => i.url).sort()).toEqual([
      "https://prnewswire.com/coverd",
      "https://reddit.com/r/biltrewards/coverd",
    ]);
    expect(report.items.map((i) => i.url)).not.toContain(
      "https://youtube.com/watch?v=shill",
    );
    // The verbatim quote is carried with its attribution + engagement.
    expect(report.bestTakes).toHaveLength(1);
    expect(report.bestTakes[0]?.quote).toContain("BILT credit is complicated");
    expect(report.bestTakes[0]?.author).toBe("u/biltfan");
    expect(report.bestTakes[0]?.engagement).toBe(81);
  });

  test("a theme citing only unknown urls is dropped; an all-junk curation falls back to deterministic", async () => {
    const reply = JSON.stringify({
      themes: [{ title: "Phantom theme", itemUrls: ["https://nope.com"] }],
      quotes: [],
    });
    const report = await runBrief({
      intake: { output: { topic: "Neobank Launches", days: 30 } },
      collect: collectStep(),
      curate: curateStep(reply),
    });
    // No theme resolves to a real item → buildReportFromCuration returns null and
    // the brief falls back to the deterministic pipeline, which still surfaces the
    // grounded Coverd items rather than emitting an empty brief.
    expect(report.clusters.some((c) => c.title === "Phantom theme")).toBe(
      false,
    );
    expect(report.items.length).toBeGreaterThan(0);
  });

  test("a malformed curate reply falls back to the deterministic brief over the collected pool", async () => {
    const report = await runBrief({
      intake: { output: { topic: "Neobank Launches", days: 30 } },
      collect: collectStep(),
      curate: curateStep("sorry, no JSON here"),
    });
    expect(report.items.length).toBeGreaterThan(0);
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

function fullTool(name: string) {
  const tool = createLast30daysTools().find((t) => t.definition.name === name);
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool.handler;
}

describe("last30days_collect (CL-2503)", () => {
  test("drains both rounds, date-filters, and dedupes into one clean pool", async () => {
    const handler = fullTool("last30days_collect");
    const recent = "2026-06-20T12:00:00Z";
    const stale = "2024-01-01T12:00:00Z";
    const steps = {
      intake: { output: { topic: "Neobank Launches", days: 30 } },
      web: {
        output: {
          content: JSON.stringify([
            {
              url: "https://x.com/launch",
              title: "Neobank launch",
              publishedAt: recent,
              source: "web",
            },
            {
              url: "https://x.com/old",
              title: "Old neobank story",
              publishedAt: stale,
              source: "web",
            },
          ]),
        },
      },
      // Round-2 re-query surfaces the same url — it must dedupe, not double-count.
      web2: {
        output: {
          content: JSON.stringify([
            {
              url: "https://x.com/launch",
              title: "Neobank launch",
              publishedAt: recent,
              source: "web",
            },
          ]),
        },
      },
    };
    const result = await handler(
      { id: "c", name: "x", arguments: steps },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    const content = result.content as {
      topic: string;
      days: number;
      items: { url: string }[];
    };
    expect(content.topic).toBe("Neobank Launches");
    const urls = content.items.map((i) => i.url);
    expect(urls).toContain("https://x.com/launch");
    // Stale item is outside the 30-day window; the dupe across rounds collapses.
    expect(urls).not.toContain("https://x.com/old");
    expect(urls.filter((u) => u === "https://x.com/launch")).toHaveLength(1);
  });
});

describe("last30days_entity_queries (CL-2503)", () => {
  async function runEntity(
    args: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const handler = fullTool("last30days_entity_queries");
    const result = await handler(
      { id: "c", name: "x", arguments: args },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    return result.content as Record<string, string>;
  }

  test("parses an entity reply into the round-2 per-source query map", async () => {
    const reply = JSON.stringify({
      web: "Coverd Telcoin Plasma One",
      reddit: "Coverd review r/CreditCards",
      x: "@telcoin Plasma One",
      youtube: "Coverd credit card review",
    });
    const content = await runEntity({ topic: "Neobank Launches", reply });
    expect(content.web).toBe("Coverd Telcoin Plasma One");
    expect(content.youtube).toBe("Coverd credit card review");
  });

  test("a malformed reply falls every round-2 source back to the base query", async () => {
    const content = await runEntity({
      topic: "the base topic",
      reply: "no json",
    });
    for (const key of ["web", "reddit", "x", "youtube"]) {
      expect(content[key]).toBe("the base topic");
    }
  });
});
