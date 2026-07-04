import { describe, expect, test } from "bun:test";
import {
  buildRedditOpportunityScannerBlocks,
  INTAKE_SIGNAL,
  opportunityContent,
  REVIEW_SIGNAL,
  SELECTION_SIGNAL,
  type RedditOpportunityScannerBlockInput,
} from "./blocks";
import type { Opportunity } from "./parse";

function analyzeReply(analysis: unknown): string {
  return JSON.stringify({ reply: JSON.stringify(analysis) });
}

const ANALYSIS = {
  whatTheySell: "Observability for platform teams",
  icp: "Platform engineers",
  competitors: ["Datadog", "Grafana"],
  keywords: [{ label: "observability" }, { label: "opentelemetry" }],
  subreddits: [{ label: "r/devops" }, { label: "sre" }],
  searches: [
    { subreddit: "r/devops", query: "otel pain" },
    { subreddit: "sre", query: "alert fatigue" },
  ],
};

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "opp_1",
    title: "Alerting is broken",
    subreddit: "devops",
    signal: "pain-point",
    content: "# Alerting is broken\n\nDetailed brief.",
    ...overrides,
  };
}

function curateReply(opportunities: Opportunity[]): string {
  return JSON.stringify({ reply: JSON.stringify({ opportunities }) });
}

function baseInput(
  overrides: Partial<RedditOpportunityScannerBlockInput> = {},
): RedditOpportunityScannerBlockInput {
  return {
    runId: "run_1",
    phase: "running",
    steps: [],
    stepOutputs: {},
    ...overrides,
  };
}

describe("reddit-opportunity-scanner blocks (CL-2769)", () => {
  test("intake gate emits a URL form bound to the intake signal", () => {
    const blocks = buildRedditOpportunityScannerBlocks(
      baseInput({
        steps: [
          {
            stepId: "intake",
            phase: "awaiting-signal",
            awaitingSignalName: INTAKE_SIGNAL,
          },
        ],
      }),
    );
    const form = blocks.find((b) => b.kind === "form");
    if (form?.kind !== "form") throw new Error("expected an intake form");
    expect(form.signalName).toBe(INTAKE_SIGNAL);
    const url = form.fields.find((f) => f.name === "inputUrl");
    if (url?.kind !== "text") throw new Error("expected a text URL field");
    expect(url.required).toBe(true);
    // The three hints are optional.
    for (const name of ["brandName", "targetGeography", "icpHints"]) {
      const field = form.fields.find((f) => f.name === name);
      const required =
        field !== undefined && field.kind !== "group"
          ? (field.required ?? false)
          : false;
      expect(required).toBe(false);
    }
  });

  test("review gate links to the run page — NOT a dock form (CL-2774)", () => {
    // The analyze step's pre-seeded search plan + recommendations can't be
    // expressed by today's form primitives (no pre-seeded rows / pre-checked
    // options), so the review gate stays on the run-page panel. Even with a
    // fully-parsed analysis available, the dock emits a run-page link, never a
    // form — shipping a form would silently discard the AI's plan.
    const blocks = buildRedditOpportunityScannerBlocks(
      baseInput({
        steps: [
          { stepId: "analyze", phase: "completed" },
          {
            stepId: "review",
            phase: "awaiting-signal",
            awaitingSignalName: REVIEW_SIGNAL,
          },
        ],
        stepOutputs: { analyze: JSON.parse(analyzeReply(ANALYSIS)) },
      }),
    );
    expect(blocks.some((b) => b.kind === "form")).toBe(false);
    const link = blocks.find((b) => b.kind === "link");
    if (link?.kind !== "link") throw new Error("expected a run-page link");
    expect(link.url).toBe("/workflows/run_1");
  });

  test("selection gate emits a reviewList with approvedKey 'selected'", () => {
    const blocks = buildRedditOpportunityScannerBlocks(
      baseInput({
        steps: [
          { stepId: "curate", phase: "completed" },
          {
            stepId: "selection",
            phase: "awaiting-signal",
            awaitingSignalName: SELECTION_SIGNAL,
          },
        ],
        stepOutputs: {
          curate: JSON.parse(
            curateReply([opportunity(), opportunity({ id: "opp_2" })]),
          ),
        },
      }),
    );
    const list = blocks.find((b) => b.kind === "reviewList");
    if (list?.kind !== "reviewList") throw new Error("expected a reviewList");
    expect(list.signalName).toBe(SELECTION_SIGNAL);
    expect(list.approvedKey).toBe("selected");
    expect(list.min).toBe(1);
    expect(list.rows.length).toBe(2);
  });

  test("selection gate defers to the run page when no opportunities were curated", () => {
    const blocks = buildRedditOpportunityScannerBlocks(
      baseInput({
        steps: [
          { stepId: "curate", phase: "completed" },
          {
            stepId: "selection",
            phase: "awaiting-signal",
            awaitingSignalName: SELECTION_SIGNAL,
          },
        ],
        stepOutputs: { curate: JSON.parse(curateReply([])) },
      }),
    );
    expect(blocks.some((b) => b.kind === "reviewList")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(true);
  });

  test("opportunityContent synthesizes a non-empty brief when curate emitted none", () => {
    const brief = opportunityContent({
      id: "opp_3",
      title: "No brief opportunity",
      subreddit: "devops",
      signal: "pain-point",
      whyItMatters: "It signals intent",
    });
    expect(brief.length).toBeGreaterThan(0);
    expect(brief).toContain("It signals intent");
  });

  test("renders progress and surfaces the completed link", () => {
    const blocks = buildRedditOpportunityScannerBlocks(
      baseInput({
        phase: "completed",
        steps: [{ stepId: "persist", phase: "completed" }],
        completedLink: { url: "/artifacts/art_1", title: "Open the scan" },
      }),
    );
    expect(blocks.some((b) => b.kind === "progress")).toBe(true);
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/artifacts/art_1");
  });
});
