import { defineAgent } from "@intx/agent";
import { awaitSignal, defineWorkflow, step } from "@intx/workflow";
import {
  canonicalizeToolNames,
  deterministicToolStep,
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

// Discover and synthesize emit multi-competitor JSON; without an explicit ceiling
// the writer source can truncate mid-object with finish_reason:"length".
const SYNTHESIZE_MAX_TOKENS = 8192;

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
    scrape: deterministicToolStep({
      id: "competitor-analysis-scrape",
      title: "Scan the company website",
      tool: "firecrawl_scrape",
      input: { from: "steps.intake.output" },
      argMap: { url: { from: "companyUrl" } },
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
    // output field is read, so persist never reshapes it.
    document: deterministicToolStep({
      id: "competitor-analysis-document",
      title: "Compose the report document",
      tool: "competitor_analysis_format_report_document",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.synthesize.output" },
        ],
      },
      after: ["synthesize"],
    }),

    // 8. Persist the report as a research artifact. document already emits
    // write_artifact's title/body verbatim, so only the two literals remain.
    packageArtifact: deterministicToolStep({
      id: "competitor-analysis-package",
      title: "Save the competitor report",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "steps.document.output.content" },
          { from: "steps.review.output" },
        ],
      },
      argMap: {
        title: { from: "title" },
        body: { from: "body" },
        kind: { literal: "research" },
        jobLabel: { literal: "Competitor analysis" },
      },
      after: ["document", "review"],
    }),
  },
});
