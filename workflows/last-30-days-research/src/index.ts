// The last-30-days-research workflow: a single-step, mail-triggered
// pipeline that researches a topic across the last 30 days and writes it
// up as one long-form, cited research report. Ported from the OG
// gtm-workbench's `last30days-research` workflow (CL-5879).
//
// ## What the OG pipeline does, step by step
// intake (await a topic + focus) -> ground (LLM: one tailored search
// query per platform) -> groundQueries (parse) -> nine source fetches,
// chained serially -> entities (LLM: name the concrete launches that
// surfaced, write deeper follow-up queries) -> entityQueries (parse) ->
// four more source fetches (round 2) -> collect (dedupe/date-filter/
// junk-filter the pool) -> curate (LLM: drop promo/off-topic, group into
// themes, pull verbatim community quotes, on the heavier writer model) ->
// brief (assemble the structured report) -> write (LLM: the long-form
// report, on the heavier writer model) -> document (pair title + body) ->
// persist (write_artifact).
//
// ## Adaptations this port makes
//
// (1) Folded to one step (CL-6495). A prior port of this file (CL-5879)
// shipped the OG's six stages as six chained `@intx/workflow` steps
// (`after: [...]`) — the first genuinely multi-step definition in this
// catalog. Every routine "run now"/scheduled fire in this repo launches
// through `@corbits/folded-runs`' `readFoldedBody`
// (`apps/hub/src/routine-launcher.ts`), and that reader has always
// required exactly one step (`packages/folded-runs/src/definition.ts`):
// it throws `"definition ... is not single-step (N steps)"` synchronously,
// before any run row or sidecar deploy exists, which Hono turns into a
// bare 500 on every single launch. There is no second, native multi-step
// launcher wired anywhere a routine could reach it. So this port folds
// the OG's six stages back into ordered PHASES inside one reasoning
// turn (see `./prompts.ts`) — the same shape every other workflow
// package in this catalog already uses, and the only shape this
// deployment's launcher can actually run.
//
// (2) Tool-dispatch shape: the OG's per-source fetches, `groundQueries`/
// `entityQueries`/`collect`/`brief`/`document`/`persist` were all native
// `action` primitives with a `handler` string ref an `ActionInvoker`
// resolves. This repo's execution host (`apps/sidecar`) has never wired
// an `ActionInvoker` — `action` is a real `@intx/workflow` primitive with
// no host support here, and every workflow package in this repo calls
// tools as agent capabilities INSIDE a reasoning turn instead. Every OG
// action becomes an instruction inside the single reasoning step's
// prompt (grounding/gathering/entity-extraction/curation/writing, all as
// phases of one turn); the OG's deterministic `collect` dedupe/
// date-filter pass is folded into the curate phase's own instructions —
// see `./prompts.ts`.
//
// (3) Model tier: the OG pinned a literal writer-tier model
// (`kimi-k2.6`, `openai-compatible`) on the curate/write stages and left
// grounding/entities on the deploy default. Folded into one step, the
// whole turn now rides the caller's own `inferencePreferences` — the
// same single-tier-per-step shape every other folded workflow in this
// catalog already uses; there is no per-phase model swap inside one
// turn.
//
// (4) Sources: the OG fanned out across nine platforms (three web
// queries, Hacker News, GitHub, Reddit, X, YouTube, Polymarket). This
// deployment has a real, honest backend for exactly two —
// `web_search` (`@corbits/web-search-tools`, Exa-backed, the same
// provider the OG used) and `github_activity` (`@corbits/github-tools`,
// GitHub's public REST search) — the same scope this repo's prior ports
// already carried and the same `topic`/`focus` intake shape the OG's own
// `INTAKE_FIELDS` and this repo's `workflow-catalog` entry already agree
// on. The remaining five stay named as "not yet connected" rather than
// silently dropped (see `LAST_30_DAYS_RESEARCH_PENDING_SOURCES`).
//
// (5) Corbits vocabulary: kept verbatim (`./prompts.ts`'s
// `CORBITS_VOCABULARY`) — the brand-correctness guidance applies here
// exactly as it did in the OG.
//
// (6) Intake: the OG parks on `awaitSignal("intake")` so a human stepper
// can fill topic/focus after the run starts. Workbench collects those
// fields on the routine *before* launch and delivers them as the
// first-turn mail (`renderRoutineInput` → `trigger.payload`). A gate
// that nobody fulfills hangs the run forever. There is no second
// intake path: the triggering mail *is* the topic/focus.
//
// ## Delivery
//
// `finalize-tool.ts` and `artifact-client.ts` are unchanged from every
// prior port. The OG's `persist` step dispatched a native
// `write_artifact` action tool with NO human approval; this repo has no
// such tool package, AND this repo's own ground rule ("every external
// side effect sits behind human approval", `AGENTS.md`) means an
// unapproved persist would be a policy regression even if a native
// action path existed here. `finalize-tool.ts`'s
// `last_30_days_research_finalize` (`approval: "ask"`) is this
// deployment's only way to reach the Library engine from a workflow tool
// package (`createWorkflowArtifact`, proven by `pain-point-collateral`/
// `collateral-generation`, CL-6000), called once inside the single
// step's turn. The step's own reply (after its one finalize tool call
// resolves) is the turn output the platform delivers through the run's
// normal mail-reply path — the same delivery every other single-step
// workflow in this catalog already uses.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";

import { buildLast30DaysResearchSystemPrompt } from "./prompts";
import { LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME } from "./finalize-tool";

export const LAST_30_DAYS_RESEARCH_WORKFLOW_ID = "wf_last_30_days_research";

// The definition's one step id. Exported so tests and any future
// delivery-card renderer can address it without hardcoding the literal.
export const LAST_30_DAYS_RESEARCH_STEP_ID = "last-30-days-research";

// Fixed section structure for the report — this deployment's own
// contract (see this file's header comment for why the OG's TL;DR/
// per-theme-heading structure was not carried over instead).
export const LAST_30_DAYS_RESEARCH_SECTIONS = [
  "Overview",
  "Key findings",
  "Sources consulted",
  "Citations",
] as const;

export const LAST_30_DAYS_RESEARCH_WIRED_SOURCES = [
  "Web search",
  "GitHub",
] as const;
export const LAST_30_DAYS_RESEARCH_PENDING_SOURCES = [
  "Hacker News",
  "Reddit",
  "X",
  "YouTube",
  "Polymarket",
] as const;

/**
 * Tool packages this definition pins (CL-5999): the two wired sources'
 * real backends. Tools are never inlined on the definition — they
 * arrive as pinned packages on the deploy, keeping the definition pure
 * data.
 */
export const LAST_30_DAYS_RESEARCH_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] =
  [
    { name: "@corbits/web-search-tools", version: "0.0.4" },
    { name: "@corbits/github-tools", version: "0.0.5" },
  ];

const SYSTEM_PROMPT = [
  buildLast30DaysResearchSystemPrompt(LAST_30_DAYS_RESEARCH_SECTIONS),
  `Finalizing: once you have written the report, call \`${LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME}\` exactly once with outcome "report", a short title (e.g. "Last 30 days: <topic>"), and the full markdown report as content. This call requires a human's approval before it completes. Always finalize, even when nothing usable surfaced at all: in that case, still call \`${LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME}\` once with outcome "status-note", a teaching title (e.g. "Last 30 days: <topic> — no results yet"), and content that honestly explains what was searched for, names the missing or unreachable connectors by id (\`exa\` for web search), and says what to do next. Never end a run without finalizing — a plain reply with no artifact is not an acceptable outcome, even on the no-data path.`,
  "If the finalize call succeeds, present the finalized report as your reply exactly as written, with no commentary about the approval mechanism itself. If the call is denied, reply with one calm, plain sentence that the report was not approved and no action was taken; never present a denial as an error, and never apologize as if something broke.",
].join("\n\n");

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a human messages with a topic to start a run —
 * so a definition built here is per-deployment by construction.
 */
export interface Last30DaysResearchWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the last-30-days-research definition: exactly one mail-
 * triggered reasoning step whose triggering mail carries the topic and
 * optional focus (see this file's header comment for the full
 * step-by-step account and every adaptation from the OG). Tools are
 * never inlined on the definition: they arrive as packages on the
 * deploy (`@corbits/web-search-tools`, `@corbits/github-tools`), keeping
 * the definition pure data — matching every other definition in this
 * catalog.
 */
export function buildLast30DaysResearchWorkflow(
  input: Last30DaysResearchWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildLast30DaysResearchWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildLast30DaysResearchWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }

  return defineWorkflow({
    id: LAST_30_DAYS_RESEARCH_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [LAST_30_DAYS_RESEARCH_STEP_ID]: step({
        agent: {
          id: LAST_30_DAYS_RESEARCH_STEP_ID,
          description:
            "Researches a topic over the last 30 days across web search " +
            "and GitHub, and writes a cited report, once a human approves it",
          systemPrompt: SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: LAST_30_DAYS_RESEARCH_TOOL_PACKAGE_PINS,
        } satisfies AgentDefinition,
        timeout: input.turnTimeoutMs,
      }),
    },
  });
}

/**
 * Serializes a definition to the JSON a workflow asset carries. The
 * definition must survive the asset round-trip byte-faithfully, so
 * anything JSON would silently drop or mangle — functions, undefined,
 * symbols, bigints, non-finite numbers, class instances — is a loud
 * error naming the offending path instead of a corrupted asset.
 */
export function serializeLast30DaysResearchWorkflow(
  definition: WorkflowDefinition,
): string {
  assertJsonPortable(definition, "definition");
  return JSON.stringify(definition);
}

function assertJsonPortable(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${path} is a non-finite number; JSON drops it`);
      }
      return;
    case "object":
      break;
    default:
      throw new Error(
        `${path} is a ${typeof value}, which does not survive JSON ` +
          "serialization",
      );
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertJsonPortable(element, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `${path} is a non-plain object; JSON would flatten it lossily`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}

export {
  LAST_30_DAYS_RESEARCH_FINALIZE_TOOL,
  LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
  LAST_30_DAYS_RESEARCH_FINALIZE_DESCRIPTION,
  buildArtifactPayload,
} from "./finalize-tool";
export type { ArtifactPayload, FinalizeArgs } from "./finalize-tool";
