import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { createRedditTools } from "@workbench/tools-reddit";
import {
  RedditReviewPayloadSchema,
  RedditSelectionPayloadSchema,
} from "@workbench/shared";
import {
  buildRedditOpportunityScannerBlocks,
  SELECTION_SIGNAL,
  type RedditOpportunityScannerBlockInput,
} from "./blocks";
import { COLLECT_ARG_MAP, PERSIST_ARG_MAP } from "./index";
import type { Opportunity } from "./parse";

// Integration test across the two per-variant MAP traps this workflow owns
// (CL-2769) — the class of bug that hit #595 (ab-compare) and was avoided in
// #603 (last30days). Nothing is mocked at the seam under test:
//   collect:  a review search row → the REAL COLLECT_ARG_MAP → the REAL
//             `reddit_subreddit_search` tool's arg normalization → API URL.
//   persist:  a reviewList row payload → the REAL PERSIST_ARG_MAP →
//             artifact_create args.
// Driving through the workflow's own exported argMaps means a field-name typo
// in index.ts (e.g. `subreddit: { from: "subredddit" }`) fails these tests, not
// just a mis-shaped hand-rolled copy. Each MUST fail on a naive verbatim
// migration (tool doesn't strip "r/" / reviewList payload = display fields only)
// and pass with the relocated server-side normalization + full-object payload.
//
// The collect trap is gate-surface-independent: the review gate stays on the
// run-page panel (CL-2774), but the panel posts the same `searches` the collect
// step maps over, so this exercises the panel path too.

type ArgSpec = { readonly from: string } | { readonly literal: unknown };

// Apply a workflow argMap the way the runtime does: each tool-arg name pulls a
// field off the mapped payload (`from`) or takes a constant (`literal`).
function applyArgMap(
  payload: Record<string, unknown>,
  argMap: Record<string, ArgSpec>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [arg, spec] of Object.entries(argMap)) {
    if ("literal" in spec) {
      args[arg] = spec.literal;
    } else {
      args[arg] = payload[spec.from];
    }
  }
  return args;
}

function curateReply(opportunities: Opportunity[]): string {
  return JSON.stringify({ reply: JSON.stringify({ opportunities }) });
}

type Captured = { url: string };

function capturingFetcher(captured: Captured[]) {
  return async (url: string): Promise<Response> => {
    captured.push({ url });
    return new Response(JSON.stringify({ posts: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("reddit-opportunity-scanner collect map (fidelity)", () => {
  it("a review search row reaches the tool r/-stripped with defaulted sort/timeframe via the real argMap", async () => {
    // The shape the recommendation-review gate emits: a search that kept the
    // inferred "r/devops" subreddit and no per-row sort/timeframe/limit. This is
    // exactly what the collect map hands each `reddit_subreddit_search` call.
    const reviewPayload = {
      keywords: ["observability"],
      subreddits: ["devops"],
      searches: [{ subreddit: "r/devops", query: "otel pain" }],
    };
    // The /resume boundary accepts it.
    expect(
      RedditReviewPayloadSchema(reviewPayload) instanceof type.errors,
    ).toBe(false);

    const captured: Captured[] = [];
    const tools = createRedditTools({
      apiKey: "sc-key",
      fetcher: capturingFetcher(captured),
    });
    const tool = tools.find(
      (t) => t.definition.name === "reddit_subreddit_search",
    );
    if (tool?.kind !== "string") {
      throw new Error("reddit_subreddit_search not found");
    }

    for (const search of reviewPayload.searches) {
      // Drive through the REAL collect argMap — a typo in index.ts fails here.
      const toolArgs = applyArgMap(search, COLLECT_ARG_MAP);
      expect(toolArgs.subreddit).toBe("r/devops");
      expect(toolArgs.query).toBe("otel pain");
      await tool.handler(toolArgs, new AbortController().signal);
    }

    expect(captured.length).toBe(1);
    const url = new URL(captured[0]!.url);
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

    // Drive each selected opportunity through the REAL persist argMap — a typo
    // in index.ts (title/content field names) fails here. Each artifact_create
    // gets a non-empty title + content, including the opportunity curate gave no
    // content, whose brief the builder synthesized. A naive migration (row
    // payload = display fields only) would carry no content and fail.
    expect(emitted.selected.length).toBe(2);
    for (const selected of emitted.selected) {
      const args = applyArgMap(
        selected as Record<string, unknown>,
        PERSIST_ARG_MAP,
      );
      expect(args.kind).toBe("reddit-opportunity-scan");
      expect(typeof args.title).toBe("string");
      expect((args.title as string).length).toBeGreaterThan(0);
      expect(typeof args.content).toBe("string");
      expect((args.content as string).length).toBeGreaterThan(0);
    }
    // The synthesized brief carries the opportunity's real signal detail.
    const synthesized = applyArgMap(
      emitted.selected[1] as Record<string, unknown>,
      PERSIST_ARG_MAP,
    ).content as string;
    expect(synthesized).toContain("Actively evaluating vendors");
  });
});
