import { defineAgent } from "@intx/agent";
import { action, awaitSignal, defineWorkflow, step } from "@intx/workflow";
import {
  canonicalizeStepToolName,
  canonicalizeToolNames,
  agentStep,
  LLM_CREDENTIAL_NAME,
  LLM_WRITER_MODEL,
  LLM_PROVIDER,
  STEP_TITLE_TAG,
  withCorbitsVocabulary,
} from "@workbench/agents";
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
// embedded def's `intakeFields` from the SAME list `./blocks.ts`'s intake
// form renders — without this the Routines/attach form has nothing to
// render and the /resume boundary rejects the empty payload it collects.
// Sourced from `./intake-fields` (not `./blocks`) so this server-side entry
// never gains a runtime edge onto `@workbench/blocks`.
export { INTAKE_FIELDS } from "./intake-fields";

// Discover and synthesize emit multi-competitor JSON; without an explicit ceiling
// the writer source can truncate mid-object with finish_reason:"length".
const SYNTHESIZE_MAX_TOKENS = 8192;

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via `canonicalizeStepToolName`'s build-time-checked lookup, so
// a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const FIRECRAWL_SCRAPE_HANDLER = canonicalizeStepToolName(
  "competitor-analysis-scrape",
  "firecrawl_scrape",
);
export const FORMAT_REPORT_DOCUMENT_HANDLER = canonicalizeStepToolName(
  "competitor-analysis-document",
  "competitor_analysis_format_report_document",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "competitor-analysis-package",
  "write_artifact",
);

// Tool-using discovery agent: runs Exa searches (and optional Firecrawl scrapes)
// against the profile's discoveryQueries, then emits a grounded competitor list.
// Capabilities only — never inline tool factories (definition is pushed as JSON).
export const DISCOVER_TOOLS = ["exa_search", "firecrawl_scrape"] as const;

const discoverAgent = defineAgent({
  id: "competitor-analysis-discover",
  description:
    "Discovers competitors with public evidence via Exa search and optional peer scrapes.",
  systemPrompt: withCorbitsVocabulary(buildDiscoverSystemPrompt()),
  tools: [],
  capabilities: canonicalizeToolNames([...DISCOVER_TOOLS]),
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_WRITER_MODEL }],
  },
  tags: {
    credentialName: LLM_CREDENTIAL_NAME,
    [STEP_TITLE_TAG]: "Discover competitors",
  },
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
    // schema ignores the other intake fields.
    scrape: action({
      handler: FIRECRAWL_SCRAPE_HANDLER,
      input: { from: "steps.intake.output" },
      effect: { requires: [FIRECRAWL_SCRAPE_HANDLER] },
      after: ["intake"],
    }),

    // 3. Infer subject profile + discovery search queries from the scrape.
    profile: agentStep({
      id: "competitor-analysis-profile",
      title: "Define the company profile",
      systemPrompt: buildProfileSystemPrompt(),
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
    synthesize: agentStep({
      id: "competitor-analysis-synthesize",
      title: "Write the competitor report",
      systemPrompt: buildSynthesizeSystemPrompt(),
      model: LLM_WRITER_MODEL,
      maxTokens: SYNTHESIZE_MAX_TOKENS,
      input: {
        project: { from: "steps" },
        fields: ["intake", "profile", "discover"],
      },
      after: ["discover"],
    }),

    // 6. Human approves the report before it is persisted.
    review: awaitSignal({ name: "review", after: ["synthesize"] }),

    // 7. Pairs the researched company's URL with the synthesize agent's reply
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

    // 8. Persist the report as a research artifact. document already emits
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
