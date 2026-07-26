import { defineAgent } from "@intx/agent";
import { action, awaitSignal, defineWorkflow, step } from "@intx/workflow";
import {
  buildDiscoverSystemPrompt,
  buildProfileSystemPrompt,
  buildSynthesizeSystemPrompt,
} from "./prompts";

// -------------------------------------------------------------------------
// Workflow metadata
// -------------------------------------------------------------------------

export const label = "Competitor Analysis";
export const description =
  "Research a company via Firecrawl and Exa, discover top competitors with evidence, and save a reviewable competitor report.";
export const kind = "competitor-analysis";

// Re-export the user-facing display flow so it travels with the workflow package
// for the server catalog classifier; the client panel imports it from the same
// browser-safe module.
export { DISPLAY_STEPS } from "./display-steps";

// Schedule-field metadata (CL-4538): re-exported so `build-workflow-defs`
// (which reads a workflow module's `INTAKE_FIELDS` export) populates the
// embedded def's `intakeFields` from the SAME list `./step-ui.ts`'s `STEP_UI`
// intake entry renders — without this the Routines/attach form has nothing
// to render and the /resume boundary rejects the empty payload it collects.
export { INTAKE_FIELDS } from "./step-ui";

// Tag shared with every reasoning step, naming the step in the
// catalog/run-page preview in place of the humanized step-map key.
const STEP_TITLE_TAG = "workbench.title";

// Corbits terminology guidance every reasoning step's system prompt carries,
// so agent output spells Corbits/Corbits.dev/Interchange/Faremeter
// consistently regardless of how the source material spelled them.
const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

function withCorbitsVocabulary(systemPrompt: string): string {
  return [CORBITS_VOCABULARY, systemPrompt].join("\n\n");
}

// The tenant-resolved inference source every reasoning step shares, and the
// heavier model the long-form synthesis step opts into.
const LLM_CREDENTIAL_NAME = "opencode-zen";
const LLM_PROVIDER = "openai-compatible";
const LLM_WRITER_MODEL = "kimi-k2.6";

// Discover and synthesize emit multi-competitor JSON; without an explicit ceiling
// the writer source can truncate mid-object with finish_reason:"length".
const SYNTHESIZE_MAX_TOKENS = 8192;

// Handler refs — the tool's canonical (factory-prefixed) runtime name,
// hardcoded literally. `packages/tool-manifest/src/resolvable-handlers.test.ts`
// checks every committed workflow def's handler strings against the
// committed tool manifest, so a typo'd or manifest-drifted string still
// fails the build rather than deploying a step nothing can dispatch.
export const FIRECRAWL_SCRAPE_HANDLER =
  "@workbench/tools-firecrawl/firecrawl:firecrawl_scrape";
export const EXA_SEARCH_HANDLER = "@workbench/tools-exa/exa:exa_search";
export const WRITE_ARTIFACT_HANDLER =
  "@workbench/tools-artifact/artifact:write_artifact";
export const FORMAT_REPORT_DOCUMENT_HANDLER =
  "@workbench/workflow-competitor-analysis/core:competitor_analysis_format_report_document";
export const BUILD_REVIEW_GATE_HANDLER =
  "@workbench/workflow-competitor-analysis/core:competitor_analysis_build_review_gate";

// Tool-using discovery agent: runs Exa searches (and optional Firecrawl scrapes)
// against the profile's discoveryQueries, then emits a grounded competitor list.
// Capabilities only — never inline tool factories (definition is pushed as JSON).
export const DISCOVER_TOOLS = [EXA_SEARCH_HANDLER, FIRECRAWL_SCRAPE_HANDLER];

const discoverAgent = defineAgent({
  id: "competitor-analysis-discover",
  description:
    "Discovers competitors with public evidence via Exa search and optional peer scrapes.",
  systemPrompt: withCorbitsVocabulary(buildDiscoverSystemPrompt()),
  tools: [],
  capabilities: DISCOVER_TOOLS,
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_WRITER_MODEL }],
  },
  tags: {
    credentialName: LLM_CREDENTIAL_NAME,
    [STEP_TITLE_TAG]: "Discover competitors",
  },
});

const profileAgent = defineAgent({
  id: "competitor-analysis-profile",
  description: "Reasoning step: competitor-analysis-profile",
  systemPrompt: withCorbitsVocabulary(buildProfileSystemPrompt()),
  tools: [],
  capabilities: [],
  inference: { sources: [] },
  tags: { [STEP_TITLE_TAG]: "Define the company profile" },
});

const synthesizeAgent = defineAgent({
  id: "competitor-analysis-synthesize",
  description: "Reasoning step: competitor-analysis-synthesize",
  systemPrompt: withCorbitsVocabulary(buildSynthesizeSystemPrompt()),
  tools: [],
  capabilities: [],
  inference: {
    sources: [
      {
        provider: LLM_PROVIDER,
        model: LLM_WRITER_MODEL,
        parameters: { maxTokens: SYNTHESIZE_MAX_TOKENS },
      },
    ],
  },
  tags: { [STEP_TITLE_TAG]: "Write the competitor report" },
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Human names the company (URL required; name/focus optional).
    intake: awaitSignal({ name: "intake" }),

    // 2. Scrape the company site — load-bearing for the subject profile.
    // Native `action`: intake's `url` field already equals firecrawl_scrape's
    // arg name (renamed at the source — firecrawl_scrape is shared by
    // other workflows/agents, so the rename lives in this workflow's own
    // intake schema, not the tool). Passed verbatim: the tool's arktype
    // schema ignores the other intake fields. This step is fatal — a failed
    // scrape has no alternate source, so a failure fails the run.
    scrape: action({
      handler: FIRECRAWL_SCRAPE_HANDLER,
      input: { from: "steps.intake.output" },
      effect: { requires: [FIRECRAWL_SCRAPE_HANDLER] },
      after: ["intake"],
    }),

    // 3. Infer subject profile + discovery search queries from the scrape.
    profile: step({
      agent: profileAgent,
      input: {
        merge: [
          { from: "steps.scrape.output" },
          { from: "steps.intake.output" },
        ],
      },
      after: ["scrape"],
    }),

    // 4. Tool-using discovery: Exa + optional peer scrapes → competitor shortlist.
    discover: step({
      agent: discoverAgent,
      input: {
        merge: [
          { from: "steps.profile.output" },
          { from: "steps.intake.output" },
        ],
      },
      after: ["profile"],
    }),

    // 5. Fold profile + discover into a reviewable report (markdown + cards).
    synthesize: step({
      agent: synthesizeAgent,
      input: {
        project: { from: "steps" },
        fields: ["intake", "profile", "discover"],
      },
      after: ["discover"],
    }),

    // 6. Build the review gate's block from the synthesized report. Native
    // `action`, tolerant: the tool never fails — a report that can't be
    // decoded still renders the Approve/Reject choice (the envelope is
    // encoded inside `content`, matching the current builder's behaviour of
    // still showing the choice when the report is malformed).
    reviewGate: action({
      handler: BUILD_REVIEW_GATE_HANDLER,
      input: {
        project: { from: "steps.synthesize.output" },
        fields: ["reply"],
      },
      effect: { requires: [BUILD_REVIEW_GATE_HANDLER] },
      after: ["synthesize"],
    }),

    // 7. Human approves the report before it is persisted.
    review: awaitSignal({ name: "review", after: ["reviewGate"] }),

    // 8. Pairs the researched company's URL with the synthesize agent's reply
    // into { title, body } (CL-4232) — the one place the agent's `reply`
    // output field is read, so persist never reshapes it. Native `action`:
    // the tool reads `url`/`reply` straight off the merged input (both
    // already top-level, unrenamed — the tool's sole caller, so its arg was
    // renamed `companyUrl` → `url` to match intake), so this never
    // needs a reshape step.
    document: action({
      handler: FORMAT_REPORT_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.synthesize.output" },
        ],
      },
      effect: { requires: [FORMAT_REPORT_DOCUMENT_HANDLER] },
      after: ["synthesize"],
    }),

    // 9. Persist the report as a research artifact. document already emits
    // write_artifact's title/body verbatim; `kind`/`jobLabel` were always
    // constants, expressed here as one `literal` merge entry — no reshape
    // step.
    packageArtifact: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          { from: "steps.document.output.content" },
          { from: "steps.review.output" },
          { literal: { kind: "research", jobLabel: "Competitor analysis" } },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["document", "review"],
    }),
  },
});
