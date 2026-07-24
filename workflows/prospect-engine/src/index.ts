import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import {
  canonicalizeToolNames,
  deterministicToolStep,
  agentStep,
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
  LLM_PROVIDER,
  LLM_WRITER_MODEL,
  STEP_TITLE_TAG,
} from "@workbench/agents";
import {
  PROSPECT_ENGINE_ARTIFACT_KIND_LEDGER,
  PROSPECT_ENGINE_ARTIFACT_KIND_REPORT,
  PROSPECT_ENGINE_DISCOVER_FORBIDDEN_TOOLS,
  PROSPECT_ENGINE_LEDGER_ARTIFACT_TITLE,
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
    label:
      "Slack channel id (#prospect-engine, optional — digest always mails to your inbox)",
    placeholder: "C…",
    required: false,
  },
  {
    kind: "select",
    name: "growthEngineListId",
    label: "Engine - Growth Sumble list",
    optionsSource: "sumble-organization-lists",
    required: true,
  },
  {
    kind: "select",
    name: "enterpriseEngineListId",
    label: "Engine - Enterprise Sumble list",
    optionsSource: "sumble-organization-lists",
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
//   initBudget → findLedger → readLedger? → parseLedger
//   pipeline / growthList / enterpriseList (nonFatal)
//   extract list org ids (avoids content-key collisions on merge)
//   discover (agent) → dedupe → score → qualify → mapReveal
//   formatReport → persist → formatDigest (after persist for artifact deep link)
//   mergeLedger → saveLedger (write_artifact upsert by title)
//   addGrowth / addEnterprise → mailRefs → mail → slack
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

    // Durable ledger is a per-owner artifact (principalId + title + kind),
    // not global memory_save — avoids clobbering Myra/operator memory.
    // Cold start: find returns JSON null → readLedger skips (optional
    // artifactId) → parseLedger still runs and emits empty ledger.
    findLedger: deterministicToolStep({
      id: "prospect-engine-find-ledger",
      title: "Locate seen-accounts ledger artifact",
      tool: "artifact_find_by_title",
      input: { from: "trigger.payload" },
      argMap: {
        title: { literal: PROSPECT_ENGINE_LEDGER_ARTIFACT_TITLE },
        kind: { literal: PROSPECT_ENGINE_ARTIFACT_KIND_LEDGER },
      },
      after: ["initBudget"],
    }),

    readLedger: deterministicToolStep({
      id: "prospect-engine-read-ledger",
      title: "Read seen-accounts ledger body",
      tool: "artifact_read",
      input: { from: "steps.findLedger.output" },
      argMap: {
        // artifactId is the sole argMap field and artifact_read's only
        // required argument, so there is no sensible "call it without an
        // id" — skipStepIfAbsent: when find returns null (no ledger yet),
        // skip this step entirely rather than fail the night. parseLedger
        // tolerates missing body.
        artifactId: {
          fromJson: "content",
          field: "artifactId",
          skipStepIfAbsent: true,
        },
      },
      after: ["findLedger"],
      nonFatal: true,
    }),
    parseLedger: deterministicToolStep({
      id: "prospect-engine-parse-ledger",
      title: "Parse seen-accounts ledger",
      tool: "prospect_engine_parse_ledger",
      // Always run after the read attempt. No argMap: cold-start nights (and
      // nonFatal artifact_read isError envelopes) omit `content`; the parse
      // tool returns an empty ledger instead of failing the run.
      input: {
        merge: [
          { from: "steps.initBudget.output.content" },
          { from: "steps.readLedger.output" },
        ],
      },
      after: ["initBudget", "readLedger"],
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

    // One extract step — project list steps like heartbeat_merge_brief_sources.
    // Fatal when registered: empty list reads still produce [] org ids.
    extractListOrgs: deterministicToolStep({
      id: "prospect-engine-extract-list-org-ids",
      title: "Extract exclusion list org ids",
      tool: "prospect_engine_extract_list_org_ids",
      input: {
        project: { from: "steps" },
        fields: ["pipeline", "growthList", "enterpriseList"],
      },
      after: ["pipeline", "growthList", "enterpriseList"],
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
        "extractListOrgs",
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
          { from: "steps.extractListOrgs.output.content" },
        ],
      },
      argMap: {
        candidates: { fromJson: "reply", field: "candidates" },
        ledger: { from: "ledger" },
        // Defaults to [] when a list read failed nonFatally and extract saw
        // error envelopes (extractOrganizationIds returns []).
        pipelineOrgIds: { from: "pipelineOrgIds" },
        growthOrgIds: { from: "growthOrgIds" },
        enterpriseOrgIds: { from: "enterpriseOrgIds" },
      },
      after: ["discover", "parseLedger", "extractListOrgs"],
    }),

    score: agentStep({
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
        // Qualified shortlist is the membership/order authority.
        baseAccounts: { from: "accounts" },
        // Map/reveal overlay (contacts/emails). Optional so a thin/failed map
        // still delivers the qualified shortlist via baseAccounts merge.
        accounts: {
          fromJson: "reply",
          field: "accounts",
          optional: true,
        },
        // Durable budget id — format_report reads used credits from the store.
        budgetId: { from: "budgetId", optional: true },
        // Fallback if budget store miss (agent-reported charges).
        creditsUsed: {
          fromJson: "reply",
          field: "creditsCharged",
          optional: true,
        },
        stopReason: { fromJson: "reply", field: "stopReason", optional: true },
      },
      after: ["mapReveal", "qualify", "initBudget"],
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

    // Digest after persist so Slack deep-links include artifactId + runId.
    // Read accounts/credits/stopReason from formatReport (always present) —
    // never re-parse map reply or optional trigger fields (optional argMap
    // keys skip the whole step when absent).
    formatDigest: deterministicToolStep({
      id: "prospect-engine-format-slack-digest",
      title: "Format Slack digest",
      tool: "prospect_engine_format_slack_digest",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatReport.output.content" },
          { from: "steps.persist.output" },
        ],
      },
      argMap: {
        runDate: { from: "runDate" },
        accounts: { from: "accounts" },
        creditsUsed: { from: "creditsUsed" },
        stopReason: { from: "stopReason" },
        artifactId: { fromJson: "content", field: "artifactId" },
        runId: { from: "runId" },
      },
      after: ["formatReport", "persist"],
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
        ],
      },
      argMap: {
        ledger: { from: "ledger" },
        runDate: { from: "runDate" },
        accounts: { from: "accounts" },
        creditsUsed: { from: "creditsUsed" },
        stopReason: { from: "stopReason" },
      },
      after: ["parseLedger", "formatReport"],
    }),

    saveLedger: deterministicToolStep({
      id: "prospect-engine-save-ledger-artifact",
      title: "Save the prospect ledger artifact",
      tool: "write_artifact",
      input: {
        merge: [{ from: "steps.mergeLedger.output.content" }],
      },
      argMap: {
        title: { literal: PROSPECT_ENGINE_LEDGER_ARTIFACT_TITLE },
        body: { from: "content" },
        kind: { literal: PROSPECT_ENGINE_ARTIFACT_KIND_LEDGER },
        jobLabel: { literal: label },
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

    // Slack is one delivery destination among several, not a prerequisite —
    // the digest already reached the user's inbox via `mail` above. Skip this
    // step entirely when no channel is configured (skipStepIfAbsent), and
    // nonFatal as a safety net so a Slack failure never blocks the run.
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
        channel: { from: "slackChannelId", skipStepIfAbsent: true },
        text: { from: "text" },
      },
      after: [
        "persist",
        "saveLedger",
        "addGrowth",
        "addEnterprise",
        "formatDigest",
        "mail",
      ],
      nonFatal: true,
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
