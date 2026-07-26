import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import {
  RedditReviewPayloadSchema,
  RedditSelectionPayloadSchema,
} from "@workbench/shared";
import {
  buildRedditOpportunityScannerBlocks,
  SELECTION_SIGNAL,
  type RedditOpportunityScannerBlockInput,
} from "./blocks";
import {
  createRedditOpportunityScannerCollectTools,
  REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION,
} from "./collect-tool";
import { opportunityToArtifactCreateArgs } from "./persist-tool";
import type { Opportunity } from "./parse";

// Integration test across the two per-variant MAP traps this workflow owns
// (CL-2769) — the class of bug that hit #595 (ab-compare) and was avoided in
// #603 (last30days). Nothing is mocked at the seam under test:
//   collect:  a review search row → the REAL
//             `reddit_opportunity_scanner_collect_searches` batch tool
//             (`collect-tool.ts`) → the REAL `reddit_subreddit_search` tool's
//             arg normalization (`normalizeSubredditSearchArgs` in
//             `@workbench/tools-reddit`) → API URL.
//   persist:  a reviewList row payload → the REAL
//             `opportunityToArtifactCreateArgs` (the batch persist tool's
//             own field mapping, `persist-tool.ts`) → artifact_create args.
// Driving through the collect tool's own handler and the persist tool's own
// mapping function means a field-name typo, or a renamed field in either
// tool, fails these tests, not just a mis-shaped hand-rolled copy. Each MUST
// fail on a naive verbatim migration (tool doesn't strip "r/" / reviewList
// payload = display fields only) and pass with the relocated server-side
// normalization + full-object payload.
//
// The collect trap is gate-surface-independent: the review gate stays on the
// run-page panel (CL-2774), but the panel posts the same `searches` the
// collect step's batch tool loops over, so this exercises the panel path too.

function findCollectSearchesTool(
  env: Parameters<typeof createRedditOpportunityScannerCollectTools>[0],
) {
  const tool = createRedditOpportunityScannerCollectTools(env).find(
    (t) =>
      t.definition.name ===
      REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION.name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(
      "reddit_opportunity_scanner_collect_searches not registered",
    );
  }
  return tool;
}

function curateReply(opportunities: Opportunity[]): string {
  return JSON.stringify({ reply: JSON.stringify({ opportunities }) });
}

describe("reddit-opportunity-scanner collect batch tool (fidelity)", () => {
  it("a review search row reaches the tool r/-stripped with defaulted sort/timeframe via the REAL collect batch tool", async () => {
    // The shape the recommendation-review gate emits: a search that kept the
    // inferred "r/devops" subreddit and no per-row sort/timeframe/limit. This is
    // exactly what the collect action hands the batch tool.
    const reviewPayload = {
      keywords: ["observability"],
      subreddits: ["devops"],
      searches: [{ subreddit: "r/devops", query: "otel pain" }],
    };
    // The /resume boundary accepts it.
    expect(
      RedditReviewPayloadSchema(reviewPayload) instanceof type.errors,
    ).toBe(false);

    const capturedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL): Promise<Response> => {
      capturedUrls.push(url.toString());
      return new Response(JSON.stringify({ posts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const env = {
        [toolCredentialEnvKey("scrapecreators")]: {
          apiKey: "sc-key",
          baseURL: "",
        },
      } as unknown as Parameters<
        typeof createRedditOpportunityScannerCollectTools
      >[0];
      const tool = findCollectSearchesTool(env);

      // Drive through the REAL collect batch tool — a typo in collect-tool.ts
      // or in @workbench/tools-reddit's normalization fails here.
      const result = await tool.handler(
        {
          id: "call_fidelity",
          name: tool.definition.name,
          arguments: { searches: reviewPayload.searches },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBe(false);
      const content = result.content as { results: unknown[] };
      expect(content.results.length).toBe(1);
      // Success path passes the underlying tool's raw JSON string through
      // unwrapped — confirms the search was NOT tolerance-enveloped as a failure.
      expect(typeof content.results[0]).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedUrls.length).toBe(1);
    const url = new URL(capturedUrls[0]!);
    // The load-bearing assertion: the "r/" prefix is stripped server-side. A
    // naive migration (tool doesn't strip) would send "r/devops" and fail here.
    expect(url.searchParams.get("subreddit")).toBe("devops");
    expect(url.searchParams.get("query")).toBe("otel pain");
    // The panel's former per-row defaults now apply server-side.
    expect(url.searchParams.get("sort")).toBe("relevance");
    expect(url.searchParams.get("timeframe")).toBe("month");
  });
});

function selectionInput(
  opportunities: Opportunity[],
): RedditOpportunityScannerBlockInput {
  return {
    runId: "run_1",
    phase: "running",
    steps: [
      { stepId: "curate", phase: "completed" },
      {
        stepId: "selection",
        phase: "awaiting-signal",
        awaitingSignalName: SELECTION_SIGNAL,
      },
    ],
    stepOutputs: { curate: JSON.parse(curateReply(opportunities)) },
  };
}

describe("reddit-opportunity-scanner selection gate → persist map (fidelity)", () => {
  it("each reviewList-selected opportunity carries a title + content the persist argMap hands artifact_create", () => {
    // One opportunity WITH curate content, one WITHOUT — the builder must
    // guarantee a non-empty content brief for both.
    const opportunities: Opportunity[] = [
      {
        id: "opp_1",
        title: "Alerting is broken",
        subreddit: "devops",
        signal: "pain-point",
        content: "# Alerting is broken\n\nDetailed brief.",
      },
      {
        id: "opp_2",
        title: "Wants OTel guidance",
        subreddit: "sre",
        signal: "buying-signal",
        whyItMatters: "Actively evaluating vendors",
      },
    ];

    const blocks = buildRedditOpportunityScannerBlocks(
      selectionInput(opportunities),
    );
    const list = blocks.find((b) => b.kind === "reviewList");
    if (list?.kind !== "reviewList") throw new Error("expected a reviewList");

    // Approve every row → the reviewList emits their FULL payloads under the
    // approvedKey "selected".
    const emitted = {
      selected: list.rows.map((row) => row.payload),
      decisions: list.rows.map((row) => ({
        ...(row.payload as object),
        approved: true,
      })),
    };

    // The /resume boundary accepts it (each selected has a non-empty title +
    // content).
    expect(RedditSelectionPayloadSchema(emitted) instanceof type.errors).toBe(
      false,
    );

    // Drive each selected opportunity through the REAL persist tool's field
    // mapping — a typo in persist-tool.ts (title/content field names) fails
    // here. Each artifact_create gets a non-empty title + content, including
    // the opportunity curate gave no content, whose brief the builder
    // synthesized. A naive migration (row payload = display fields only)
    // would carry no content and fail.
    expect(emitted.selected.length).toBe(2);
    for (const selected of emitted.selected) {
      const args = opportunityToArtifactCreateArgs(
        selected as Record<string, unknown>,
      );
      expect(args.kind).toBe("reddit-opportunity-scan");
      expect(typeof args.title).toBe("string");
      expect((args.title as string).length).toBeGreaterThan(0);
      expect(typeof args.content).toBe("string");
      expect((args.content as string).length).toBeGreaterThan(0);
    }
    // The synthesized brief carries the opportunity's real signal detail.
    const synthesized = opportunityToArtifactCreateArgs(
      emitted.selected[1] as Record<string, unknown>,
    ).content as string;
    expect(synthesized).toContain("Actively evaluating vendors");
  });
});
