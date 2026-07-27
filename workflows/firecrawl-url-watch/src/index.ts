import { action, awaitSignal, defineWorkflow, step } from "@intx/workflow";
import { defineAgent } from "@intx/agent";

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

// Tag shared with every step class, naming the step in the catalog/run-UI
// preview in place of the humanized step-map key.
const STEP_TITLE_TAG = "workbench.title";

// Corbits terminology guidance every reasoning step's system prompt carries,
// so the digest agent spells Corbits/Corbits.dev/Interchange/Faremeter
// consistently regardless of how the source material spelled them.
const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

// Handler refs — the tool's canonical (factory-prefixed) runtime name. Each
// literal is checked against the committed tool manifest by a repo-level test
// (`packages/tool-manifest/src/resolvable-handlers.test.ts`), so a typo'd or
// manifest-drifted handler string still fails the build rather than deploying
// a step nothing can dispatch.
export const FIRECRAWL_SCRAPE_HANDLER =
  "@workbench/tools-firecrawl/firecrawl:firecrawl_scrape";
export const WRITE_ARTIFACT_HANDLER =
  "@workbench/tools-artifact/artifact:write_artifact";
export const FORMAT_DOCUMENT_HANDLER =
  "@workbench/workflow-firecrawl-url-watch/core:firecrawl_url_watch_format_document";

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

    // Native `step({ agent })`: a plain reasoning-with-tools step built from
    // `defineAgent`, mirroring what `@workbench/agents`' `agentStep` sugar
    // wraps — no per-step model preference here, so the step uses the
    // deploy's default model.
    digest: step({
      agent: defineAgent({
        id: "firecrawl-url-watch-digest",
        description: "Reasoning step: firecrawl-url-watch-digest",
        systemPrompt: [CORBITS_VOCABULARY, DIGEST_SYSTEM_PROMPT].join("\n\n"),
        tools: [],
        capabilities: [],
        inference: { sources: [] },
        tags: { [STEP_TITLE_TAG]: "Write the digest" },
      }),
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
    // its own tool — `firecrawl_url_watch_format_document` (shipped in this
    // workflow's own `@workbench/workflow-firecrawl-url-watch` package) — whose
    // schema takes `url` verbatim, so the same intake output merges into
    // both `fetch` and `document` unchanged.
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
