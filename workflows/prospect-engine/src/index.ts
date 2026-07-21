import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import {
  canonicalizeToolNames,
  deterministicToolStep,
  inlineInferenceStep,
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
  LLM_PROVIDER,
  LLM_WRITER_MODEL,
  STEP_TITLE_TAG,
} from "@workbench/agents";
import {
  PROSPECT_ENGINE_ARTIFACT_KIND_REPORT,
  PROSPECT_ENGINE_DISCOVER_FORBIDDEN_TOOLS,
  PROSPECT_ENGINE_PIPELINE_LIST_ID,
  PROSPECT_ENGINE_WORKFLOW_KIND,
} from "@workbench/shared";
import {
  buildProspectEngineDiscoverPrompt,
  buildProspectEngineMapRevealPrompt,
  buildProspectEngineScorePrompt,
} from "./prompts";

export const label = "Prospect engine";
export const description =
  "Nightly unattended prospecting: Sumble discover → qualify → map contacts → scored list + Slack digest. List building only — never outreach.";
export const kind = PROSPECT_ENGINE_WORKFLOW_KIND;

export { DISPLAY_STEPS } from "./display-steps";

/** Schedule attach UI fields (list ids + Slack until tenant constants ship). */
export const INTAKE_FIELDS = [
  {
    kind: "text",
    name: "slackChannelId",
    label: "Slack channel id (#prospect-engine)",
    placeholder: "C…",
    required: true,
  },
  {
    kind: "text",
    name: "growthEngineListId",
    label: "Engine - Growth Sumble list id",
    required: true,
  },
  {
    kind: "text",
    name: "enterpriseEngineListId",
    label: "Engine - Enterprise Sumble list id",
    required: true,
  },
  {
    kind: "string-array",
    name: "verticals",
    label: "Vertical focus (optional)",
    placeholder: "AI, payments, legal tech",
  },
] as const;

// ---------------------------------------------------------------------------
// Discover agent — read-only Sumble + budget charge awareness
// ---------------------------------------------------------------------------

const DISCOVER_TOOLS = [
  "sumble_search_organizations",
  "sumble_search_signals",
  "sumble_find_technologies",
  "sumble_lookup_technologies",
  "sumble_lookup_job_titles",
  "sumble_get_organization_signals",
  "sumble_resolve_organization",
  "prospect_engine_charge_credits",
] as const;

const discoverAgent = defineAgent({
  id: "prospect-engine-discover",
  description: "Read-only Sumble discovery for overnight prospect engine.",
  systemPrompt: buildProspectEngineDiscoverPrompt(),
  tools: [],
  capabilities: canonicalizeToolNames([...DISCOVER_TOOLS]),
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_DEFAULT_MODEL }],
  },
  tags: {
    credentialName: LLM_CREDENTIAL_NAME,
    [STEP_TITLE_TAG]: "Discover candidates",
  },
});

const MAP_REVEAL_TOOLS = [
  "sumble_search_people",
  "sumble_get_organization_signals",
  "sumble_list_jobs",
  "prospect_engine_charge_credits",
] as const;

const mapRevealAgent = defineAgent({
  id: "prospect-engine-map-reveal",
  description:
    "Map buying centers and reveal top contact emails under credit cap.",
  systemPrompt: buildProspectEngineMapRevealPrompt(),
  tools: [],
  capabilities: canonicalizeToolNames([...MAP_REVEAL_TOOLS]),
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_DEFAULT_MODEL }],
  },
  tags: {
    credentialName: LLM_CREDENTIAL_NAME,
    [STEP_TITLE_TAG]: "Map contacts",
  },
});

// ---------------------------------------------------------------------------
// Graph (gate-free / unattended)
//
//   initBudget → loadMemory → parseLedger
//   pipeline / growthList / enterpriseList (nonFatal, parallel after parseLedger)
//   discover (agent, read-only Sumble)
//   dedupe → score (inline) → qualify → mapReveal (agent)
//   formatReport → formatDigest → persist → mergeLedger → serializeLedger
//   saveMemory → addGrowth → addEnterprise → mailRefs → mail → slack
// ---------------------------------------------------------------------------

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    initBudget: deterministicToolStep({
      id: "prospect-engine-init-budget",
      title: "Initialize credit budget",
      tool: "prospect_engine_init_budget",
      input: { from: "trigger.payload" },
      argMap: {},
    }),

    loadMemory: deterministicToolStep({
      id: "prospect-engine-load-memory",
      title: "Load durable memory",
      tool: "memory_load",
      input: { from: "trigger.payload" },
      argMap: {
        scope: { literal: "global" },
      },
      after: ["initBudget"],
      nonFatal: true,
    }),

    parseLedger: deterministicToolStep({
      id: "prospect-engine-parse-ledger",
      title: "Parse seen-accounts ledger",
      tool: "prospect_engine_parse_ledger",
      input: { from: "steps.loadMemory.output" },
      argMap: {
        content: { from: "content" },
      },
      after: ["loadMemory"],
    }),

    pipeline: deterministicToolStep({
      id: "prospect-engine-read-pipeline-list",
      title: "Read Attio Active Pipeline exclusions",
      tool: "sumble_get_organization_list",
      input: { from: "trigger.payload" },
      argMap: {
        listId: { literal: PROSPECT_ENGINE_PIPELINE_LIST_ID },
      },
      after: ["parseLedger"],
      nonFatal: true,
    }),

    growthList: deterministicToolStep({
      id: "prospect-engine-read-growth-list",
      title: "Read Engine - Growth list",
      tool: "sumble_get_organization_list",
      input: { from: "trigger.payload" },
      argMap: {
        listId: { from: "growthEngineListId" },
      },
      after: ["parseLedger"],
      nonFatal: true,
    }),

    enterpriseList: deterministicToolStep({
      id: "prospect-engine-read-enterprise-list",
      title: "Read Engine - Enterprise list",
      tool: "sumble_get_organization_list",
      input: { from: "trigger.payload" },
      argMap: {
        listId: { from: "enterpriseEngineListId" },
      },
      after: ["parseLedger"],
      nonFatal: true,
    }),

    discover: step({
      agent: discoverAgent,
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.initBudget.output" },
          { from: "steps.parseLedger.output" },
          { from: "steps.pipeline.output" },
          { from: "steps.growthList.output" },
          { from: "steps.enterpriseList.output" },
        ],
      },
      after: [
        "initBudget",
        "parseLedger",
        "pipeline",
        "growthList",
        "enterpriseList",
      ],
    }),

    dedupe: deterministicToolStep({
      id: "prospect-engine-dedupe-candidates",
      title: "Dedupe candidates",
      tool: "prospect_engine_dedupe_candidates",
      input: {
        merge: [
          { from: "steps.discover.output" },
          { from: "steps.parseLedger.output.content" },
          { from: "steps.pipeline.output" },
          { from: "steps.growthList.output" },
          { from: "steps.enterpriseList.output" },
        ],
      },
      argMap: {
        candidates: { fromJson: "reply", field: "candidates" },
        ledger: { from: "ledger" },
        pipelineListResult: { from: "content" },
        growthListResult: { from: "content" },
        enterpriseListResult: { from: "content" },
      },
      after: [
        "discover",
        "parseLedger",
        "pipeline",
        "growthList",
        "enterpriseList",
      ],
    }),

    score: inlineInferenceStep({
      id: "prospect-engine-score",
      title: "Score candidates",
      systemPrompt: buildProspectEngineScorePrompt(),
      model: LLM_WRITER_MODEL,
      maxTokens: 8192,
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.dedupe.output.content" },
        ],
      },
      after: ["dedupe"],
    }),

    qualify: deterministicToolStep({
      id: "prospect-engine-qualify",
      title: "Qualify shortlist",
      tool: "prospect_engine_qualify",
      input: { from: "steps.score.output" },
      argMap: {
        candidates: { fromJson: "reply", field: "candidates" },
      },
      after: ["score"],
    }),

    mapReveal: step({
      agent: mapRevealAgent,
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.initBudget.output.content" },
          { from: "steps.qualify.output.content" },
        ],
      },
      after: ["qualify", "initBudget"],
    }),

    formatReport: deterministicToolStep({
      id: "prospect-engine-format-report",
      title: "Format nightly report",
      tool: "prospect_engine_format_report",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.mapReveal.output" },
          { from: "steps.qualify.output.content" },
          { from: "steps.initBudget.output.content" },
        ],
      },
      argMap: {
        runDate: { from: "runDate" },
        accounts: { fromJson: "reply", field: "accounts" },
        creditsUsed: { from: "used" },
        stopReason: { fromJson: "reply", field: "stopReason" },
      },
      after: ["mapReveal", "qualify", "initBudget"],
    }),

    formatDigest: deterministicToolStep({
      id: "prospect-engine-format-slack-digest",
      title: "Format Slack digest",
      tool: "prospect_engine_format_slack_digest",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatReport.output.content" },
          { from: "steps.initBudget.output.content" },
          { from: "steps.mapReveal.output" },
        ],
      },
      argMap: {
        runDate: { from: "runDate" },
        accounts: { from: "accounts" },
        creditsUsed: { from: "used" },
        remainingBudget: { from: "remaining" },
        sumbleCreditBalance: { from: "sumbleCreditBalance" },
        stopReason: { fromJson: "reply", field: "stopReason" },
      },
      after: ["formatReport", "initBudget", "mapReveal"],
    }),

    persist: deterministicToolStep({
      id: "prospect-engine-save-nightly-report",
      title: "Save the nightly prospect report",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatReport.output.content" },
        ],
      },
      argMap: {
        title: { from: "artifactTitle" },
        body: { from: "body" },
        kind: { literal: PROSPECT_ENGINE_ARTIFACT_KIND_REPORT },
        jobLabel: { literal: label },
      },
      after: ["formatReport"],
    }),

    mergeLedger: deterministicToolStep({
      id: "prospect-engine-merge-ledger",
      title: "Merge tonight into ledger",
      tool: "prospect_engine_merge_ledger",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.parseLedger.output.content" },
          { from: "steps.formatReport.output.content" },
          { from: "steps.initBudget.output.content" },
          { from: "steps.mapReveal.output" },
        ],
      },
      argMap: {
        ledger: { from: "ledger" },
        runDate: { from: "runDate" },
        accounts: { from: "accounts" },
        creditsUsed: { from: "used" },
        stopReason: { fromJson: "reply", field: "stopReason" },
        remainingBalance: { from: "sumbleCreditBalance" },
      },
      after: ["parseLedger", "formatReport", "initBudget", "mapReveal"],
    }),

    saveMemory: deterministicToolStep({
      id: "prospect-engine-save-durable-memory",
      title: "Save the prospect ledger",
      tool: "memory_save",
      input: { from: "steps.mergeLedger.output.content" },
      argMap: {
        content: { from: "content" },
        scope: { literal: "global" },
      },
      after: ["mergeLedger"],
    }),

    addGrowth: deterministicToolStep({
      id: "prospect-engine-add-growth-organizations",
      title: "Add qualified orgs to Engine - Growth",
      tool: "sumble_add_organization_list_organizations",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatReport.output.content" },
        ],
      },
      argMap: {
        listId: { from: "growthEngineListId" },
        organizationIds: { from: "growthOrganizationIds" },
      },
      after: ["formatReport"],
      nonFatal: true,
    }),

    addEnterprise: deterministicToolStep({
      id: "prospect-engine-add-enterprise-organizations",
      title: "Add qualified orgs to Engine - Enterprise",
      tool: "sumble_add_organization_list_organizations",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatReport.output.content" },
        ],
      },
      argMap: {
        listId: { from: "enterpriseEngineListId" },
        organizationIds: { from: "enterpriseOrganizationIds" },
      },
      after: ["formatReport"],
      nonFatal: true,
    }),

    mailRefs: deterministicToolStep({
      id: "prospect-engine-format-mail-refs",
      title: "Build mail deep links",
      tool: "prospect_engine_format_mail_refs",
      input: {
        merge: [{ from: "trigger.payload" }, { from: "steps.persist.output" }],
      },
      argMap: {
        artifactId: { fromJson: "content", field: "artifactId" },
        runId: { from: "runId" },
        workflowLabel: { literal: label },
      },
      after: ["persist"],
      nonFatal: true,
    }),

    mail: deterministicToolStep({
      id: "prospect-engine-mail-digest",
      title: "Mail the prospect list",
      tool: "mail_send",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatDigest.output.content" },
          { from: "steps.mailRefs.output.content" },
        ],
      },
      argMap: {
        to: { from: "userAddress" },
        subject: { from: "artifactTitle" },
        content: { from: "text" },
        refs: { from: "refs" },
      },
      after: ["formatDigest", "mailRefs"],
      nonFatal: true,
    }),

    notify: deterministicToolStep({
      id: "prospect-engine-post-slack-digest",
      title: "Post the Slack digest",
      tool: "slack_post_message",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatDigest.output.content" },
        ],
      },
      argMap: {
        channel: { from: "slackChannelId" },
        text: { from: "text" },
      },
      after: [
        "persist",
        "saveMemory",
        "addGrowth",
        "addEnterprise",
        "formatDigest",
        "mail",
      ],
    }),
  },
});

/** Test helper: discover capabilities never include write tools. */
export function discoverForbiddenToolsPresent(
  capabilities: readonly string[],
): string[] {
  const set = new Set(capabilities);
  return PROSPECT_ENGINE_DISCOVER_FORBIDDEN_TOOLS.filter((t) => set.has(t));
}
