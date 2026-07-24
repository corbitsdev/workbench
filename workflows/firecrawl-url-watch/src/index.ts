import { awaitSignal, defineWorkflow } from "@intx/workflow";
import { agentStep, deterministicToolStep } from "@workbench/agents";

export const label = "Website URL watch";
export const description =
  "On a schedule, scrape a URL with Firecrawl and save a short change/summary digest artifact.";
export const kind = "firecrawl-url-watch";

/**
 * Schedule-field metadata for Routines (CL-4262). Thin URL scrape watch —
 * Firecrawl's remote monitor CRUD stays available to agents; this productizes
 * a single URL on a Workbench schedule without external monitor IDs.
 */
export const INTAKE_FIELDS = [
  {
    name: "url",
    label: "URL",
    inputHint: "url" as const,
    required: true,
    help: "Page to scrape each run.",
    placeholder: "https://example.com/pricing",
    order: 0,
  },
  {
    name: "focus",
    label: "Watch focus",
    inputHint: "text" as const,
    required: false,
    help: "Optional: what to pay attention to (pricing, changelog, blog, etc.).",
    placeholder: "pricing changes",
    order: 1,
  },
] as const;

const DIGEST_SYSTEM_PROMPT = `You write short unattended website-watch digests for a scheduled scrape.

You receive the URL, optional focus, and Firecrawl scrape output (markdown/main content).

Write a concise markdown digest:
1. One-line summary of the page state
2. Key sections or claims relevant to the focus (or overall if no focus)
3. Anything that looks new, promotional, or decision-relevant
4. "Watch next time" — 1–3 things to re-check on the next scrape

No preamble. No tool calls. Markdown body only.`;

export const workflow = defineWorkflow({
  id: kind,
  steps: {
    // Intake-only human gate — scheduler pre-fills + auto-delivers on schedule
    // fire (CL-3509). humanGateCount === 1 + requiresIntake → structurally
    // attachable; routine eligibility is derived (CL-4204) from whether the
    // entry step's required trigger fields are covered by declared intake
    // fields (`url`, `focus`) — see `@workbench/shared`'s `isRoutineEligibleKind`.
    intake: awaitSignal({ name: "intake" }),

    fetch: deterministicToolStep({
      id: "firecrawl-url-watch-fetch",
      title: "Scrape the URL",
      tool: "firecrawl_scrape",
      input: { from: "steps.intake.output" },
      argMap: {
        url: { from: "url" },
        onlyMainContent: { literal: true },
      },
      after: ["intake"],
    }),

    digest: agentStep({
      id: "firecrawl-url-watch-digest",
      title: "Write the digest",
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      // Merge objects only. firecrawl_scrape is a stringTool — content is a
      // JSON string, so merge the whole envelope ({ content }), not .content.
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.fetch.output" },
        ],
      },
      after: ["fetch"],
    }),

    document: deterministicToolStep({
      id: "firecrawl-url-watch-document",
      title: "Compose the digest document",
      tool: "last30days_format_report_document",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.digest.output" },
        ],
      },
      argMap: {
        topic: { from: "url" },
        reply: { from: "reply" },
      },
      after: ["digest"],
    }),

    persist: deterministicToolStep({
      id: "firecrawl-url-watch-persist",
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
