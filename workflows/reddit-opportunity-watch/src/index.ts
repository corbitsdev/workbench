import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import { agentStep, canonicalizeStepToolName } from "@workbench/agents";

export const label = "Reddit opportunity watch";
export const description =
  "On a schedule, search a subreddit for opportunity posts and save a short unattended digest — no mid-run review gates.";
export const kind = "reddit-opportunity-watch";

/**
 * Schedule-field metadata for Routines (CL-4260). Sibling to the guided
 * reddit-opportunity-scanner (which keeps HITL review); this path is unattended.
 */
export const INTAKE_FIELDS = [
  {
    name: "subreddit",
    label: "Subreddit",
    inputHint: "text" as const,
    required: true,
    help: "Subreddit name without the r/ prefix.",
    placeholder: "devops",
    order: 0,
  },
  {
    name: "query",
    label: "Search query",
    inputHint: "text" as const,
    required: true,
    help: "What to search for inside that subreddit.",
    placeholder: "hiring OR looking for tools",
    order: 1,
  },
  {
    name: "timeframe",
    label: "Timeframe",
    inputHint: "select" as const,
    required: false,
    help: "Reddit search window (default week).",
    order: 2,
    options: [
      { value: "day", label: "Day" },
      { value: "week", label: "Week" },
      { value: "month", label: "Month" },
      { value: "year", label: "Year" },
      { value: "all", label: "All" },
    ],
  },
] as const;

// Native `action` handler refs — same build-time-checked lookup
// `deterministicToolStep` uses, so a typo'd or manifest-drifted tool name
// fails the build instead of deploying a step nothing can dispatch.
export const REDDIT_SUBREDDIT_SEARCH_HANDLER = canonicalizeStepToolName(
  "reddit-opportunity-watch-fetch",
  "reddit_subreddit_search",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "reddit-opportunity-watch-persist",
  "write_artifact",
);
export const FORMAT_DIGEST_DOCUMENT_HANDLER = canonicalizeStepToolName(
  "reddit-opportunity-watch-document",
  "reddit_opportunity_watch_format_digest_document",
);

const DIGEST_SYSTEM_PROMPT = `You write short unattended Reddit opportunity digests for a scheduled watch.

You receive subreddit, query, optional timeframe, and raw reddit_subreddit_search results (JSON research items with url, title, engagement, sometimes topComments).

Write a concise markdown digest:
1. One-line headline of the opportunity landscape
2. Top posts (3–8) with why each is an opportunity (pain, buying signal, question to answer)
3. Suggested angles for outreach or content (2–4 bullets)

No mid-run selection — pick the best yourself. No preamble. No tool calls. Markdown body only.`;

export const workflow = defineWorkflow({
  id: kind,
  steps: {
    // Unattended: schedule/Routines supply intake; no mid-run HITL after this.
    intake: awaitSignal({ name: "intake" }),

    // Native action: reddit_subreddit_search's args (subreddit, query,
    // timeframe, sort, limit) already equal the intake field names except
    // `sort`, which this workflow always fixes to "relevance" — merged in as
    // a literal rather than renamed, since reddit_subreddit_search is a
    // shared tool (also called by reddit-opportunity-scanner) and no rename
    // is needed here anyway.
    fetch: action({
      handler: REDDIT_SUBREDDIT_SEARCH_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { literal: { sort: "relevance" } },
        ],
      },
      effect: { requires: [REDDIT_SUBREDDIT_SEARCH_HANDLER] },
      after: ["intake"],
    }),

    digest: agentStep({
      id: "reddit-opportunity-watch-digest",
      title: "Write the opportunity digest",
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      // Merge whole step outputs (objects). `fetch.output.content` is an array
      // and cannot be a merge operand — it arrives nested under `content`.
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.fetch.output" },
        ],
      },
      after: ["fetch"],
    }),

    // Native action: last30days_format_report_document takes `topic`, which
    // no native selector can rename from this workflow's intake `query`
    // field (also consumed as-is by reddit_subreddit_search) without
    // touching that shared, multi-caller formatter. Rather than renaming a
    // shared tool's arg, this workflow ships its own tiny formatter —
    // reddit_opportunity_watch_format_digest_document (shipped in this
    // workflow's own `@workbench/tools-reddit-opportunity-watch` package) —
    // that already takes `query` verbatim, so intake's `query` and digest's
    // `reply` merge straight through with no rename.
    document: action({
      handler: FORMAT_DIGEST_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.digest.output" },
        ],
      },
      effect: { requires: [FORMAT_DIGEST_DOCUMENT_HANDLER] },
      after: ["digest"],
    }),

    // Native action: reddit_opportunity_watch_format_digest_document already
    // emits { title, body } (write_artifact's own arg names) under `content`
    // — no rename needed. `kind`/`jobLabel` are fixed literals merged
    // alongside.
    persist: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          { from: "steps.document.output.content" },
          { literal: { kind: "research", jobLabel: label } },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["document"],
    }),
  },
});
