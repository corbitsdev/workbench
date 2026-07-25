import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import { agentStep, canonicalizeStepToolName } from "@workbench/agents";

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

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via the same build-time-checked lookup `deterministicToolStep`
// uses, so a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const FIRECRAWL_SCRAPE_HANDLER = canonicalizeStepToolName(
  "firecrawl-url-watch-fetch",
  "firecrawl_scrape",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "firecrawl-url-watch-persist",
  "write_artifact",
);
export const FORMAT_DOCUMENT_HANDLER = canonicalizeStepToolName(
  "firecrawl-url-watch-document",
  "firecrawl_url_watch_format_document",
);

export const workflow = defineWorkflow({
  id: kind,
  steps: {
    // Intake-only human gate — scheduler pre-fills + auto-delivers on schedule
    // fire (CL-3509). humanGateCount === 1 + requiresIntake → structurally
    // attachable; routine eligibility is derived (CL-4204) from whether the
    // entry step's required trigger fields are covered by declared intake
    // fields (`url`, `focus`) — see `@workbench/shared`'s `isRoutineEligibleKind`.
    intake: awaitSignal({ name: "intake" }),

    // Native action: `firecrawl_scrape`'s arktype schema already declares
    // `url` (required) and `onlyMainContent` (optional boolean) verbatim, so
    // intake's own `url` field plus a literal `onlyMainContent: true` is the
    // exact argument object — no reshape needed.
    fetch: action({
      handler: FIRECRAWL_SCRAPE_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { literal: { onlyMainContent: true } },
        ],
      },
      effect: { requires: [FIRECRAWL_SCRAPE_HANDLER] },
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

    // Native action: `last30days_format_report_document` requires its
    // title-arg spelled `topic`, which this workflow cannot supply without
    // renaming the SAME intake value `fetch` already consumes as `url` (and
    // native selectors cannot rename a field). Rather than alias that
    // shared, 5-caller tool for one workflow's naming, this workflow ships
    // its own tool — `firecrawl_url_watch_format_document` (packages/
    // tools-last30days) — whose schema takes `url` verbatim, so the same
    // intake output merges into both `fetch` and `document` unchanged.
    document: action({
      handler: FORMAT_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.digest.output" },
        ],
      },
      effect: { requires: [FORMAT_DOCUMENT_HANDLER] },
      after: ["digest"],
    }),

    // Native action: `document`'s handler (format_report_document) already
    // returns `{ content: { title, body } }` with field names matching
    // `write_artifact`'s schema (`title`, `body`) verbatim, so merging that
    // content with a literal `{ kind, jobLabel }` object is the exact
    // argument shape — no reshape needed.
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
