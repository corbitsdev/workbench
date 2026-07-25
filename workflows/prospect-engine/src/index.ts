import { defineAgent } from "@intx/agent";
import { action, defineWorkflow, step } from "@intx/workflow";
import {
  canonicalizeStepToolName,
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

// Native `action` handler refs — the tool's canonical (factory-prefixed)
// name, resolved via the same build-time-checked lookup `deterministicToolStep`
// uses, so a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch (CL-4454).
export const INIT_BUDGET_HANDLER = canonicalizeStepToolName(
  "prospect-engine-init-budget",
  "prospect_engine_init_budget",
);
export const FIND_LEDGER_HANDLER = canonicalizeStepToolName(
  "prospect-engine-find-ledger",
  "artifact_find_by_title",
);
export const PARSE_LEDGER_HANDLER = canonicalizeStepToolName(
  "prospect-engine-parse-ledger",
  "prospect_engine_parse_ledger",
);
export const EXTRACT_LIST_ORG_IDS_HANDLER = canonicalizeStepToolName(
  "prospect-engine-extract-list-org-ids",
  "prospect_engine_extract_list_org_ids",
);
export const EXTRACT_CANDIDATES_FROM_REPLY_HANDLER = canonicalizeStepToolName(
  "prospect-engine-extract-candidates",
  "prospect_engine_extract_candidates_from_reply",
);
export const DEDUPE_CANDIDATES_HANDLER = canonicalizeStepToolName(
  "prospect-engine-dedupe-candidates",
  "prospect_engine_dedupe_candidates",
);
export const QUALIFY_HANDLER = canonicalizeStepToolName(
  "prospect-engine-qualify",
  "prospect_engine_qualify",
);
export const EXTRACT_MAP_REVEAL_OVERLAY_HANDLER = canonicalizeStepToolName(
  "prospect-engine-extract-map-overlay",
  "prospect_engine_extract_map_reveal_overlay",
);
export const FORMAT_REPORT_HANDLER = canonicalizeStepToolName(
  "prospect-engine-format-report",
  "prospect_engine_format_report",
);
export const WRITE_ARTIFACT_REPORT_HANDLER = canonicalizeStepToolName(
  "prospect-engine-save-nightly-report",
  "write_artifact",
);
export const FORMAT_SLACK_DIGEST_HANDLER = canonicalizeStepToolName(
  "prospect-engine-format-slack-digest",
  "prospect_engine_format_slack_digest",
);
export const MERGE_LEDGER_HANDLER = canonicalizeStepToolName(
  "prospect-engine-merge-ledger",
  "prospect_engine_merge_ledger",
);
export const WRITE_ARTIFACT_LEDGER_HANDLER = canonicalizeStepToolName(
  "prospect-engine-save-ledger-artifact",
  "write_artifact",
);

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
    initBudget: action({
      handler: INIT_BUDGET_HANDLER,
      input: { literal: {} },
      effect: { requires: [INIT_BUDGET_HANDLER] },
    }),

    // Durable ledger is a per-owner artifact (principalId + title + kind),
    // not global memory_save — avoids clobbering Myra/operator memory.
    // Cold start: find returns JSON null → readLedger skips (optional
    // artifactId) → parseLedger still runs and emits empty ledger.
    findLedger: action({
      handler: FIND_LEDGER_HANDLER,
      input: {
        literal: {
          title: PROSPECT_ENGINE_LEDGER_ARTIFACT_TITLE,
          kind: PROSPECT_ENGINE_ARTIFACT_KIND_LEDGER,
        },
      },
      effect: { requires: [FIND_LEDGER_HANDLER] },
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
    // No argMap on the legacy version either: cold-start nights (and nonFatal
    // artifact_read isError envelopes) omit `content`; the tool returns an
    // empty ledger instead of failing the run. Native `action`, verbatim.
    parseLedger: action({
      handler: PARSE_LEDGER_HANDLER,
      input: {
        merge: [
          { from: "steps.initBudget.output.content" },
          { from: "steps.readLedger.output" },
        ],
      },
      effect: { requires: [PARSE_LEDGER_HANDLER] },
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
    extractListOrgs: action({
      handler: EXTRACT_LIST_ORG_IDS_HANDLER,
      input: {
        project: { from: "steps" },
        fields: ["pipeline", "growthList", "enterpriseList"],
      },
      effect: { requires: [EXTRACT_LIST_ORG_IDS_HANDLER] },
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

    // Native `action` selectors can read/rename/merge paths but cannot
    // JSON.parse a string field — the discover agent's reply is a JSON
    // string with a `candidates` array, which the legacy argMap unwrapped
    // via `fromJson`. This shaping step is the one place that reply is
    // parsed (CL-4454); dedupe below reads a plain `candidates` array.
    extractDiscoverCandidates: action({
      handler: EXTRACT_CANDIDATES_FROM_REPLY_HANDLER,
      input: { from: "steps.discover.output" },
      effect: { requires: [EXTRACT_CANDIDATES_FROM_REPLY_HANDLER] },
      after: ["discover"],
    }),

    dedupe: action({
      handler: DEDUPE_CANDIDATES_HANDLER,
      input: {
        merge: [
          { from: "steps.extractDiscoverCandidates.output.content" },
          { from: "steps.parseLedger.output.content" },
          { from: "steps.extractListOrgs.output.content" },
        ],
      },
      effect: { requires: [DEDUPE_CANDIDATES_HANDLER] },
      after: ["extractDiscoverCandidates", "parseLedger", "extractListOrgs"],
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

    // Same reply→candidates unwrap the score agent's JSON reply needs
    // (CL-4454) — reuses the discover-side shaping tool; both agents emit
    // the identical `{"candidates": [...]}` reply contract.
    extractScoreCandidates: action({
      handler: EXTRACT_CANDIDATES_FROM_REPLY_HANDLER,
      input: { from: "steps.score.output" },
      effect: { requires: [EXTRACT_CANDIDATES_FROM_REPLY_HANDLER] },
      after: ["score"],
    }),

    qualify: action({
      handler: QUALIFY_HANDLER,
      input: { from: "steps.extractScoreCandidates.output.content" },
      effect: { requires: [QUALIFY_HANDLER] },
      after: ["extractScoreCandidates"],
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

    // The map/reveal agent's JSON reply needs the same fromJson-only unwrap
    // (CL-4454) — tolerant here (see the tool's definition comment), since a
    // thin/failed map must still deliver the qualified shortlist.
    extractMapRevealOverlay: action({
      handler: EXTRACT_MAP_REVEAL_OVERLAY_HANDLER,
      input: { from: "steps.mapReveal.output" },
      effect: { requires: [EXTRACT_MAP_REVEAL_OVERLAY_HANDLER] },
      after: ["mapReveal"],
    }),

    // Qualify already emits its shortlist aliased as `baseAccounts` (in
    // addition to `accounts`) so this merge never collides on the map
    // overlay's own `accounts` key (CL-4454) — no reshape step needed here.
    formatReport: action({
      handler: FORMAT_REPORT_HANDLER,
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.extractMapRevealOverlay.output.content" },
          { from: "steps.qualify.output.content" },
          { from: "steps.initBudget.output.content" },
        ],
      },
      effect: { requires: [FORMAT_REPORT_HANDLER] },
      after: ["extractMapRevealOverlay", "qualify", "initBudget"],
    }),

    // Trigger payload's report title field is named `title` at the source
    // (this workflow's own intake — @workbench/shared's
    // ProspectEngineTriggerPayloadSchema, CL-4454) precisely so it lands on
    // write_artifact's `title` arg unrenamed; formatReport already emits
    // `body` verbatim. No reshape needed.
    persist: action({
      handler: WRITE_ARTIFACT_REPORT_HANDLER,
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatReport.output.content" },
          {
            literal: {
              kind: PROSPECT_ENGINE_ARTIFACT_KIND_REPORT,
              jobLabel: label,
            },
          },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_REPORT_HANDLER] },
      after: ["formatReport"],
    }),

    // Digest after persist so Slack deep-links include artifactId + runId.
    // Read accounts/credits/stopReason from formatReport (always present) —
    // never re-parse map reply or optional trigger fields (optional argMap
    // keys skip the whole step when absent).
    // write_artifact's result carries { artifactId, version, title } as a
    // plain object already (never a stringified JSON envelope), so
    // `artifactId` is a straight top-level field once merged — no reshape
    // needed (CL-4454).
    formatDigest: action({
      handler: FORMAT_SLACK_DIGEST_HANDLER,
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.formatReport.output.content" },
          { from: "steps.persist.output.content" },
        ],
      },
      effect: { requires: [FORMAT_SLACK_DIGEST_HANDLER] },
      after: ["formatReport", "persist"],
    }),

    mergeLedger: action({
      handler: MERGE_LEDGER_HANDLER,
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.parseLedger.output.content" },
          { from: "steps.formatReport.output.content" },
        ],
      },
      effect: { requires: [MERGE_LEDGER_HANDLER] },
      after: ["parseLedger", "formatReport"],
    }),

    // mergeLedger emits `body` directly (single caller, CL-4454) so
    // write_artifact — shared across every workflow, its arg name is never
    // renamed — sees `body` unrenamed.
    saveLedger: action({
      handler: WRITE_ARTIFACT_LEDGER_HANDLER,
      input: {
        merge: [
          { from: "steps.mergeLedger.output.body" },
          {
            literal: {
              title: PROSPECT_ENGINE_LEDGER_ARTIFACT_TITLE,
              kind: PROSPECT_ENGINE_ARTIFACT_KIND_LEDGER,
              jobLabel: label,
            },
          },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_LEDGER_HANDLER] },
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
        subject: { from: "title" },
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
