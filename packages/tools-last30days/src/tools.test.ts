import { describe, expect, test } from "bun:test";
import { type Report, parseReport } from "@workbench/last30days-core";
import { createLast30daysTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

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
): Promise<Record<string, { query: string }>> {
  const handler = groundQueriesTool();
  const result = await handler(
    { id: "c1", name: "x", arguments: args },
    SIGNAL,
  );
  if (typeof result.content === "string") {
    throw new Error("expected object content, got a string");
  }
  return result.content as Record<string, { query: string }>;
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
    expect(content.github?.query).toBe("org/repo");
    expect(content.youtube?.query).toBe("video title phrasing");
    for (const key of SOURCE_KEYS) {
      expect(content[key]?.query.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("a missing or malformed reply falls every source back to the base query", async () => {
    const content = await runGround({
      topic: "a topic",
      query: "the base query",
      reply: "sorry, no JSON here",
    });
    for (const key of SOURCE_KEYS) {
      expect(content[key]?.query).toBe("the base query");
    }
  });

  test("a partial reply tailors present keys and falls back the rest", async () => {
    const content = await runGround({
      topic: "a topic",
      query: "base",
      reply: JSON.stringify({ github: "org/repo", reddit: "  " }),
    });
    expect(content.github?.query).toBe("org/repo");
    // blank value is ignored → fallback
    expect(content.reddit?.query).toBe("base");
    expect(content.web?.query).toBe("base");
  });

  test("falls back to the topic when no focus query is given", async () => {
    const content = await runGround({ topic: "the topic", reply: "{}" });
    expect(content.hackernews?.query).toBe("the topic");
  });

  test("throws when neither query nor topic is present", async () => {
    await expect(runGround({ reply: "{}" })).rejects.toThrow(/query or topic/);
  });

  // CL-4232: each source's query is nested under a `query` key so a plain
  // `{ from: "steps.groundQueries.output.content.<key>" }` selector yields
  // `{ query: "..." }` — the exa_search/etc. argument name — verbatim.
  test("nests each source's query under a query key for selector-only wiring", async () => {
    const content = await runGround({
      topic: "a topic",
      query: "base",
      reply: JSON.stringify({ web: "web query" }),
    });
    expect(content.web).toEqual({ query: "web query" });
  });
});

// CL-2765 dock-payload integration: the intake gate is now a `form` UIBlock that
// emits `{ topic, focus }` VERBATIM (no client-side derivation). This drives that
// block-shaped payload through the REAL ground-step derivation (the running
// `last30days_ground_queries` tool, via normalizeIntake) and asserts the base
// query is still the human's focus — not the bare topic. A naive verbatim-form
// migration that dropped the relocated derivation would fall the base query back
// to `topic` here and fail this test (the #595 empty/blunted-prompt class).
describe("last30days_ground_queries — block-form intake fidelity (CL-2765)", () => {
  test("a { topic, focus } form payload grounds every source on focus, not topic", async () => {
    const content = await runGround({
      topic: "AI coding agents",
      focus: "enterprise procurement risks",
      reply: "not json",
    });
    for (const key of SOURCE_KEYS) {
      expect(content[key]?.query).toBe("enterprise procurement risks");
    }
  });

  test("a { topic } form payload with no focus grounds on the topic", async () => {
    const content = await runGround({ topic: "AI coding agents", reply: "{}" });
    for (const key of SOURCE_KEYS) {
      expect(content[key]?.query).toBe("AI coding agents");
    }
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
  ): Promise<Record<string, { query: string }>> {
    const handler = fullTool("last30days_entity_queries");
    const result = await handler(
      { id: "c", name: "x", arguments: args },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    return result.content as Record<string, { query: string }>;
  }

  test("parses an entity reply into the round-2 per-source query map", async () => {
    const reply = JSON.stringify({
      web: "Coverd Telcoin Plasma One",
      reddit: "Coverd review r/CreditCards",
      x: "@telcoin Plasma One",
      youtube: "Coverd credit card review",
    });
    const content = await runEntity({ topic: "Neobank Launches", reply });
    expect(content.web?.query).toBe("Coverd Telcoin Plasma One");
    expect(content.youtube?.query).toBe("Coverd credit card review");
  });

  test("a malformed reply falls every round-2 source back to the base query", async () => {
    const content = await runEntity({
      topic: "the base topic",
      reply: "no json",
    });
    for (const key of ["web", "reddit", "x", "youtube"]) {
      expect(content[key]?.query).toBe("the base topic");
    }
  });

  // CL-4232: nested under `query` so the round-2 source step's plain path
  // selector matches exa_search/etc.'s argument name directly.
  test("nests each source's query under a query key", async () => {
    const content = await runEntity({
      topic: "the base topic",
      reply: JSON.stringify({ web: "narrowed web query" }),
    });
    expect(content.web).toEqual({ query: "narrowed web query" });
  });
});

describe("heartbeat_merge_brief_sources (CL-3485)", () => {
  test("returns every wired source under sources.* from projected intake steps", async () => {
    const handler = fullTool("heartbeat_merge_brief_sources");
    const steps = {
      "intake-granola": {
        output: {
          callId: "c1",
          isError: false,
          content: JSON.stringify({
            notes: [{ id: "n1", title: "Acme" }],
          }),
        },
      },
      "intake-linear": {
        output: {
          callId: "c2",
          isError: false,
          content: JSON.stringify({ issues: [{ id: "LIN-1" }] }),
        },
      },
      "intake-attio": {
        output: {
          callId: "c3",
          isError: false,
          content: JSON.stringify({ attioActivity: { openTasks: [] } }),
        },
      },
      "intake-vercel": {
        output: {
          callId: "c4",
          isError: true,
          content: "403 forbidden",
        },
      },
    };
    const result = await handler(
      { id: "merge", name: "heartbeat_merge_brief_sources", arguments: steps },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    const content = result.content as {
      sources: Record<string, Record<string, unknown>>;
    };
    expect(content.sources.granola?.notes).toEqual([
      { id: "n1", title: "Acme" },
    ]);
    expect(content.sources.linear?.issues).toEqual([{ id: "LIN-1" }]);
    expect(content.sources.vercel).toEqual({
      isError: true,
      error: "403 forbidden",
    });
  });
});

describe("heartbeat_format_brief_notify (CL-4232)", () => {
  test("returns the mail_send argument shape verbatim (to/subject/content/refs)", async () => {
    const handler = fullTool("heartbeat_format_brief_notify");
    const result = await handler(
      {
        id: "notify",
        name: "heartbeat_format_brief_notify",
        arguments: {
          userAddress: "usr_abc@workbench.local",
          title: "Jordan Lee's Morning Brief - 04/07/26",
          body: "# Morning brief\n\nAll clear.",
          artifactId: "art_abc",
          runId: "run_heartbeat-1",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      to: "usr_abc@workbench.local",
      subject: "Jordan Lee's Morning Brief - 04/07/26",
      content: "# Morning brief\n\nAll clear.",
      refs: [
        { kind: "artifact", ref: "art_abc", label: "Open brief" },
        {
          kind: "workflow_run",
          ref: "run_heartbeat-1",
          label: "Open Company Heartbeat",
        },
      ],
    });
  });

  test("returns isError when runId is missing", async () => {
    const handler = fullTool("heartbeat_format_brief_notify");
    const result = await handler(
      {
        id: "notify",
        name: "heartbeat_format_brief_notify",
        arguments: {
          userAddress: "usr_abc@workbench.local",
          title: "t",
          body: "b",
          artifactId: "art_abc",
        },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("runId is required");
  });
});

describe("heartbeat_format_brief_document (CL-4232)", () => {
  test("pairs title and reply into a title/body document", async () => {
    const handler = fullTool("heartbeat_format_brief_document");
    const result = await handler(
      {
        id: "document",
        name: "heartbeat_format_brief_document",
        arguments: {
          title: "Jordan Lee's Morning Brief - 04/07/26",
          reply: "# Morning brief\n\nAll clear.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "Jordan Lee's Morning Brief - 04/07/26",
      body: "# Morning brief\n\nAll clear.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("heartbeat_format_brief_document");
    const result = await handler(
      {
        id: "document",
        name: "heartbeat_format_brief_document",
        arguments: { title: "t" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });
});

describe("heartbeat_format_brief_title (CL-3502)", () => {
  test("returns a possessive title built from userDisplayName", async () => {
    const handler = fullTool("heartbeat_format_brief_title");
    const result = await handler(
      {
        id: "title",
        name: "heartbeat_format_brief_title",
        arguments: { userDisplayName: "Jordan Lee" },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    const content = result.content as { title: string };
    expect(content.title).toMatch(
      /^Jordan Lee's Morning Brief - \d{2}\/\d{2}\/\d{2}$/,
    );
  });

  test("falls back to 'Your Morning Brief' when no display name is given", async () => {
    const handler = fullTool("heartbeat_format_brief_title");
    const result = await handler(
      { id: "title", name: "heartbeat_format_brief_title", arguments: {} },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    const content = result.content as { title: string };
    expect(content.title).toMatch(/^Your Morning Brief - \d{2}\/\d{2}\/\d{2}$/);
  });
});

describe("competitor_analysis_format_report_document (CL-4232)", () => {
  test("pairs url and reply into a title/body document", async () => {
    const handler = fullTool("competitor_analysis_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "competitor_analysis_format_report_document",
        arguments: {
          url: "https://acme.com",
          reply: "## Competitor report\n\nAcme has three main rivals.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "https://acme.com",
      body: "## Competitor report\n\nAcme has three main rivals.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("competitor_analysis_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "competitor_analysis_format_report_document",
        arguments: { url: "https://acme.com" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  test("returns isError when url is missing", async () => {
    const handler = fullTool("competitor_analysis_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "competitor_analysis_format_report_document",
        arguments: { reply: "body" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("url is required");
  });
});

describe("firecrawl_url_watch_format_document (CL-4454)", () => {
  test("pairs url and reply into a title/body document", async () => {
    const handler = fullTool("firecrawl_url_watch_format_document");
    const result = await handler(
      {
        id: "document",
        name: "firecrawl_url_watch_format_document",
        arguments: {
          url: "https://example.com/pricing",
          reply: "## Digest\n\nPricing page looks unchanged.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "https://example.com/pricing",
      body: "## Digest\n\nPricing page looks unchanged.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("firecrawl_url_watch_format_document");
    const result = await handler(
      {
        id: "document",
        name: "firecrawl_url_watch_format_document",
        arguments: { url: "https://example.com/pricing" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  test("returns isError when url is missing", async () => {
    const handler = fullTool("firecrawl_url_watch_format_document");
    const result = await handler(
      {
        id: "document",
        name: "firecrawl_url_watch_format_document",
        arguments: { reply: "body" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("url is required");
  });
});

describe("sumble_account_intel_format_report_document (CL-4232)", () => {
  test("pairs organizationDomain and reply into a title/body document", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: {
          organizationDomain: "acme.com",
          reply: "## Account brief\n\nAcme is worth a look.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "acme.com",
      body: "## Account brief\n\nAcme is worth a look.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: { organizationDomain: "acme.com" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  test("returns isError when organizationDomain is missing", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: { reply: "body" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("organizationDomain is required");
  });
});

describe("github_topic_watch_format_activity_query (CL-4454)", () => {
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

describe("reddit_opportunity_watch_format_digest_document (CL-4454)", () => {
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
    const runtimeNames = createLast30daysTools()
      .map((tool) => tool.definition.name)
      .sort();
    const factory = toolManifestFile.factories[0];
    if (!factory) {
      throw new Error("expected the last30days manifest to declare a factory");
    }
    const manifestNames = [...factory.bareToolNames].sort();
    // A tool present in tools.ts but missing from tool-manifest.ts never gets
    // namespaced by canonicalizeToolNames (packages/agent-core/src/tool-names.ts
    // derives its table from this manifest), so a workflow step declaring the
    // tool stays bare while the sidecar loader registers the namespaced name —
    // the exact "tool ... is not registered/available" dispatch failure.
    expect(manifestNames).toEqual(runtimeNames);
  });
});
