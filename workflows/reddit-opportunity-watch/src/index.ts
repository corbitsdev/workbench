import { awaitSignal, defineWorkflow } from "@intx/workflow";
import { agentStep, deterministicToolStep } from "@workbench/agents";

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

    fetch: deterministicToolStep({
      id: "reddit-opportunity-watch-fetch",
      title: "Search the subreddit",
      tool: "reddit_subreddit_search",
      input: { from: "steps.intake.output" },
      argMap: {
        subreddit: { from: "subreddit" },
        query: { from: "query" },
        timeframe: { from: "timeframe" },
        sort: { literal: "relevance" },
      },
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

    document: deterministicToolStep({
      id: "reddit-opportunity-watch-document",
      title: "Compose the digest document",
      tool: "last30days_format_report_document",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.digest.output" },
        ],
      },
      argMap: {
        // Title the artifact with the search query (topic-shaped for the helper).
        topic: { from: "query" },
        reply: { from: "reply" },
      },
      after: ["digest"],
    }),

    persist: deterministicToolStep({
      id: "reddit-opportunity-watch-persist",
      title: "Save digest artifact",
      tool: "write_artifact",
      input: {
        merge: [{ from: "steps.document.output.content" }],
      },
      argMap: {
        title: { from: "title" },
        body: { from: "body" },
        kind: { literal: "research" },
        jobLabel: { literal: label },
      },
      after: ["document"],
    }),
  },
});
