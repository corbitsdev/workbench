import { awaitSignal, defineWorkflow } from "@intx/workflow";
import { agentStep, deterministicToolStep } from "@workbench/agents";

export const label = "GitHub topic watch";
export const description =
  "On a schedule, search GitHub for recent repos, issues, and PRs on a topic and save a short digest.";
export const kind = "github-topic-watch";

/**
 * Schedule-field metadata for Routines (CL-4270). Topic query + optional lookback.
 */
export const INTAKE_FIELDS = [
  {
    kind: "text",
    inputHint: "text" as const,
    name: "topic",
    label: "Topic",
    required: true,
    help: "Keyword terms only — no GitHub qualifiers (is:issue, repo:, etc.).",
    placeholder: "e.g. AI coding agents",
    order: 0,
  },
] as const;

const DIGEST_SYSTEM_PROMPT = `You write short unattended GitHub topic digests for a scheduled watch.

You receive the watch topic, optional lookback days, and raw github_activity results (JSON research items: repos, issues, PRs with url, title, publishedAt, engagement).

Write a concise markdown digest:
1. One-line headline of what moved
2. Notable repos (if any) with star/activity signal
3. Notable issues/PRs worth reading
4. "Worth a closer look" — 0–3 items with why

No preamble. No tool calls. Markdown body only.`;

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // Schedule wizard pre-fills and auto-delivers this gate (CL-3509).
    intake: awaitSignal({ name: "intake" }),

    fetch: deterministicToolStep({
      id: "github-topic-watch-fetch",
      title: "Search GitHub activity",
      tool: "github_activity",
      input: { from: "steps.intake.output" },
      argMap: {
        query: { from: "topic" },
        // Schedule forms deliver strings; github_activity expects a number.
        // Fixed 7-day lookback until number intake is supported.
        days: { literal: 7 },
      },
      // Empty results / missing PAT / rate limits should degrade into a thin
      // digest, not fail the scheduled run (CL-4270).
      nonFatal: true,
      after: ["intake"],
    }),

    digest: agentStep({
      id: "github-topic-watch-digest",
      title: "Write the digest",
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      // merge requires object operands — use fetch.output (content envelope),
      // not the content array itself.
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.fetch.output" },
        ],
      },
      after: ["fetch"],
    }),

    document: deterministicToolStep({
      id: "github-topic-watch-document",
      title: "Compose the digest document",
      tool: "last30days_format_report_document",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.digest.output" },
        ],
      },
      argMap: {
        topic: { from: "topic" },
        reply: { from: "reply" },
      },
      after: ["digest"],
    }),

    persist: deterministicToolStep({
      id: "github-topic-watch-persist",
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
