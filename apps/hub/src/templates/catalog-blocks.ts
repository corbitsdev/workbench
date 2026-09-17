// The hub's native catalog-block adapter (CL-8113, hub-zero T2): the
// deployable set `POST /template-blocks/:assetName/deploy` serves,
// composed directly from the `workflows/*` builder packages against
// `@corbits/workflows` catalog metadata — the same composition
// `@workbench/onboarding`'s `CATALOG_WORKFLOWS` table wraps, with zero
// import from that package. `assistant` (seeded already, never
// redeployed here) and `heartbeat` (test-only, never deployed onto a
// real bench) are outside this set, so they answer `undefined` here,
// same as any name outside the catalog entirely.
//
// Display names come from the native `WORKFLOW_CATALOG` entry
// (`@corbits/workflows`, the package `@workbench/templates`
// re-exports its own catalog mirror from), so the labels served here
// and the catalog's can never drift apart silently. Turn timeouts match
// the seed table's per-workflow budgets one-for-one: a research turn
// fans out and writes long-form, a call-transcript pass runs past the
// shortest catalog steps, everything else runs the conversational
// default.
//
// Server-only, on purpose: each `buildJson` closure pulls in its
// workflow package (e.g. `@corbits/granola-call-workflow`) and with it
// `@intx/agent`/`@intx/workflow`. Only `./block-workflows.ts`
// (mounted in `apps/hub` through `./template-block-routes.ts`) imports
// this; it is deliberately not re-exported from the package root.
import { workflowCatalogEntry } from "@corbits/workflows";
import {
  buildCodeReviewWorkflow,
  serializeCodeReviewWorkflow,
} from "@corbits/code-review-workflow";
import {
  buildWorkbenchDigestWorkflow,
  serializeWorkbenchDigestWorkflow,
} from "@corbits/workbench-digest-workflow";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "@corbits/echo-workflow";
import {
  buildLast30DaysResearchWorkflow,
  serializeLast30DaysResearchWorkflow,
} from "@corbits/last-30-days-research-workflow";
import {
  buildGranolaCallWorkflow,
  serializeGranolaCallWorkflow,
} from "@corbits/granola-call-workflow";
import {
  buildMorningBriefWorkflow,
  serializeMorningBriefWorkflow,
} from "@corbits/morning-brief-workflow";
import {
  buildExaTopicWatchWorkflow,
  serializeExaTopicWatchWorkflow,
} from "@corbits/exa-topic-watch-workflow";
import {
  buildProcessGranolaCallWorkflow,
  serializeProcessGranolaCallWorkflow,
} from "@corbits/process-granola-call-workflow";
import {
  buildAttioTaskAgentWorkflow,
  serializeAttioTaskAgentWorkflow,
} from "@corbits/attio-task-agent-workflow";
import {
  buildPainPointCollateralWorkflow,
  serializePainPointCollateralWorkflow,
} from "@corbits/pain-point-collateral-workflow";
import {
  buildRedditOpportunityScannerWorkflow,
  serializeRedditOpportunityScannerWorkflow,
} from "@corbits/reddit-opportunity-scanner-workflow";
import {
  buildCollateralGenerationWorkflow,
  serializeCollateralGenerationWorkflow,
} from "@corbits/collateral-generation-workflow";
import {
  buildDiligenceBriefWorkflow,
  serializeDiligenceBriefWorkflow,
} from "@corbits/diligence-brief-workflow";

const ECHO_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const WORKBENCH_DIGEST_TURN_TIMEOUT_MS = 30 * 1000;
const LAST_30_DAYS_RESEARCH_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const CODE_REVIEW_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const GRANOLA_CALL_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const MORNING_BRIEF_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const EXA_TOPIC_WATCH_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const PROCESS_GRANOLA_CALL_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const ATTIO_TASK_AGENT_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const PAIN_POINT_COLLATERAL_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const REDDIT_OPPORTUNITY_SCANNER_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const COLLATERAL_GENERATION_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const DILIGENCE_BRIEF_TURN_TIMEOUT_MS = 2 * 60 * 1000;

export type CatalogBlockInferencePreference = {
  readonly provider: string;
  readonly model: string;
};

export type CatalogBlock = {
  /** Asset name; lowercase-kebab so the smart-HTTP repo path is clean. */
  readonly assetName: string;
  /** Friendly label stamped on the asset at create time. */
  readonly displayName: string;
  /**
   * Renders the definition's JSON given the tenant's mail domain and the
   * ordered provider/model preferences to deploy against. Takes the bare
   * preference list so this same function serves the template-block
   * route's in-process deploy path, which only ever has the tenant's
   * real inference preferences on hand.
   */
  readonly buildJson: (
    tenantDomain: string,
    inferencePreferences: readonly CatalogBlockInferencePreference[],
  ) => string;
};

function catalogDisplayName(assetName: string): string {
  return workflowCatalogEntry(assetName)?.displayName ?? assetName;
}

/**
 * Workflows a tenant can deploy on demand through the template-block
 * route: every native catalog entry with a source package under
 * `workflows/<name>`, minus `assistant` (seeded already) and
 * `heartbeat` (test-only). Nothing here reaches a bench until
 * something asks for it by name.
 */
export const CATALOG_BLOCKS: readonly CatalogBlock[] = [
  {
    assetName: "echo",
    displayName: catalogDisplayName("echo"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeEchoWorkflow(
        buildEchoWorkflow({
          triggerAddress: `echo@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: ECHO_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "workbench-digest",
    displayName: catalogDisplayName("workbench-digest"),
    buildJson: (_tenantDomain, inferencePreferences) =>
      serializeWorkbenchDigestWorkflow(
        buildWorkbenchDigestWorkflow({
          inferencePreferences,
          turnTimeoutMs: WORKBENCH_DIGEST_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "last-30-days-research",
    displayName: catalogDisplayName("last-30-days-research"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeLast30DaysResearchWorkflow(
        buildLast30DaysResearchWorkflow({
          triggerAddress: `last-30-days-research@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: LAST_30_DAYS_RESEARCH_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "code-review",
    displayName: catalogDisplayName("code-review"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeCodeReviewWorkflow(
        buildCodeReviewWorkflow({
          triggerAddress: `code-review@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: CODE_REVIEW_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "granola-call",
    displayName: catalogDisplayName("granola-call"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeGranolaCallWorkflow(
        buildGranolaCallWorkflow({
          triggerAddress: `granola-call@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: GRANOLA_CALL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "morning-brief",
    displayName: catalogDisplayName("morning-brief"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeMorningBriefWorkflow(
        buildMorningBriefWorkflow({
          triggerAddress: `morning-brief@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: MORNING_BRIEF_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "exa-topic-watch",
    displayName: catalogDisplayName("exa-topic-watch"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeExaTopicWatchWorkflow(
        buildExaTopicWatchWorkflow({
          triggerAddress: `exa-topic-watch@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: EXA_TOPIC_WATCH_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "process-granola-call",
    displayName: catalogDisplayName("process-granola-call"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeProcessGranolaCallWorkflow(
        buildProcessGranolaCallWorkflow({
          triggerAddress: `process-granola-call@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: PROCESS_GRANOLA_CALL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "attio-task-agent",
    displayName: catalogDisplayName("attio-task-agent"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeAttioTaskAgentWorkflow(
        buildAttioTaskAgentWorkflow({
          triggerAddress: `attio-task-agent@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: ATTIO_TASK_AGENT_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "pain-point-collateral",
    displayName: catalogDisplayName("pain-point-collateral"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializePainPointCollateralWorkflow(
        buildPainPointCollateralWorkflow({
          triggerAddress: `pain-point-collateral@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: PAIN_POINT_COLLATERAL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "reddit-opportunity-scanner",
    displayName: catalogDisplayName("reddit-opportunity-scanner"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeRedditOpportunityScannerWorkflow(
        buildRedditOpportunityScannerWorkflow({
          triggerAddress: `reddit-opportunity-scanner@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: REDDIT_OPPORTUNITY_SCANNER_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "collateral-generation",
    displayName: catalogDisplayName("collateral-generation"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeCollateralGenerationWorkflow(
        buildCollateralGenerationWorkflow({
          triggerAddress: `collateral-generation@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: COLLATERAL_GENERATION_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "diligence-brief",
    displayName: catalogDisplayName("diligence-brief"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeDiligenceBriefWorkflow(
        buildDiligenceBriefWorkflow({
          triggerAddress: `diligence-brief@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: DILIGENCE_BRIEF_TURN_TIMEOUT_MS,
        }),
      ),
  },
];

/**
 * The asset names of `CATALOG_BLOCKS`, strings only: callers that name
 * the deployable set without building anything from it import this
 * rather than `CATALOG_BLOCKS` itself, so no per-workflow `buildJson`
 * closure crosses into their code.
 */
export const CATALOG_BLOCK_ASSET_NAMES: readonly string[] = CATALOG_BLOCKS.map(
  (block) => block.assetName,
);

/**
 * The deployable-through-the-template-block-route entry for one asset
 * name, or `undefined` if none exists. `CATALOG_BLOCKS` is the one
 * source of truth for "has a source package under `workflows/<name>`
 * and can be deployed on demand".
 */
export function deployableCatalogBlock(
  assetName: string,
): CatalogBlock | undefined {
  return CATALOG_BLOCKS.find((block) => block.assetName === assetName);
}
