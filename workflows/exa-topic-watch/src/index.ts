import { awaitSignal, defineWorkflow } from "@intx/workflow";
import { agentStep, deterministicToolStep } from "@workbench/agents";

export const label = "Web topic watch";
export const description =
  "On a schedule, search the web for a topic and save a short digest artifact.";
export const kind = "exa-topic-watch";

/**
 * Schedule-field metadata for Routines (CL-4259). Single required topic query.
 * Mirrors the intake gate payload so scheduled runs auto-deliver without a human.
 */
export const INTAKE_FIELDS = [
  {
    name: "topic",
    label: "Topic",
    inputHint: "text" as const,
    required: true,
    help: "What to watch on the web each run.",
    placeholder: "e.g. AI coding agents for GTM",
    order: 0,
  },
] as const;

const DIGEST_SYSTEM_PROMPT = `You write short unattended web-topic digests for a scheduled watch.

You receive the watch topic and raw Exa search results (JSON research items with url, title, publishedAt, source).

Write a concise markdown digest:
1. One-line headline of what moved
2. 3–7 bullet takeaways with links where useful
3. "Worth a closer look" — 0–3 items with why

No preamble. No tool calls. Markdown body only.`;

export const workflow = defineWorkflow({
  id: kind,
  steps: {
    intake: awaitSignal({ name: "intake" }),

    fetch: deterministicToolStep({
      id: "exa-topic-watch-fetch",
      title: "Search the web",
      tool: "exa_search",
      input: { from: "steps.intake.output" },
      argMap: {
        query: { from: "topic" },
      },
      after: ["intake"],
    }),

    digest: agentStep({
      id: "exa-topic-watch-digest",
      title: "Write the digest",
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      // Merge objects only (arrays fail merge selectors). Fetch tool envelope is
      // { content: ResearchItem[] }; agent sees { topic, content }.
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.fetch.output" },
        ],
      },
      after: ["fetch"],
    }),

    document: deterministicToolStep({
      id: "exa-topic-watch-document",
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
      id: "exa-topic-watch-persist",
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
