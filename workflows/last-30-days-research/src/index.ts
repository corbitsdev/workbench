// The last-30-days-research workflow: a multi-step pipeline that
// researches a topic across the last 30 days and writes it up as one
// long-form, cited research report. Ported from the OG gtm-workbench's
// `last30days-research` workflow (CL-5879), replacing this repo's prior
// single-step scoped-down port (CL-5997).
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
// (1) Tool-dispatch shape: the OG's per-source fetches, `groundQueries`/
// `entityQueries`/`collect`/`brief`/`document`/`persist` were all native
// `action` primitives with a `handler` string ref an `ActionInvoker`
// resolves. This repo's execution host (`apps/sidecar`) has never wired
// an `ActionInvoker` — `action` is a real `@intx/workflow` primitive with
// no host support here, and every existing workflow package in this repo
// (single-step, without exception) calls tools as agent capabilities
// INSIDE a reasoning turn instead. So every OG action step becomes either
// a plain reasoning `step` (grounding/entity-extraction/curation/writing)
// or is folded into a reasoning step's own instructions (the OG's
// deterministic `collect` dedupe/date-filter pass is folded into the
// curate step's prompt — see `./prompts.ts`'s header comment). This is
// the FIRST genuine multi-step (non-folded) workflow definition in this
// catalog; every other package here is single-step by convention. The
// deploy-time per-step model resolution this multi-step shape assumes
// (see adaptation 2) is accordingly unproven end-to-end in this repo and
// is called out as an honest gap below, the same way CL-5999's
// tool-package-pin gap is called out in every other workflow's README.
//
// (2) Model tiers: the OG pinned a literal writer-tier model
// (`kimi-k2.6`, `openai-compatible`) on the curate/write steps and left
// grounding/entities on the deploy default. This catalog's benches carry
// Ollama (qwen, ...) and Anthropic, never `openai-compatible`/kimi, so
// `WRITER_INFERENCE_PREFERENCE` below names `claude-sonnet-5` on
// `anthropic` instead — the same "genuine editorial judgment and
// long-form synthesis need the heavier tier; grounding/entity-extraction
// stay on the deploy default" split the OG's own comment documents.
// `curate`/`write` prepend this preference ahead of the caller's own
// `inferencePreferences`, so a tenant catalog that resolves it gets the
// writer tier and one that doesn't falls through to the deploy default —
// the same shape `InferencePreference[]`'s own doc describes ("per-source
// preference... in order"). Whether this repo's deploy-time resolver
// walks past index 0 for a genuine multi-step definition is exactly the
// gap adaptation (1) calls out; this is the correct definition-level
// intent regardless of when that resolver catches up.
//
// (3) Sources: the OG fanned out across nine platforms (three web
// queries, Hacker News, GitHub, Reddit, X, YouTube, Polymarket). This
// deployment has a real, honest backend for exactly two —
// `web_search` (`@corbits/web-search-tools`, Exa-backed, the same
// provider the OG used) and `github_activity` (`@corbits/github-tools`,
// GitHub's public REST search) — the same scope this repo's prior port
// already carried and the same `topic`/`focus` intake shape the OG's own
// `INTAKE_FIELDS` and this repo's `workflow-catalog` entry already agree
// on. The remaining five stay named as "not yet connected" rather than
// silently dropped (see `LAST_30_DAYS_RESEARCH_PENDING_SOURCES`).
//
// (4) Corbits vocabulary: kept verbatim (`./prompts.ts`'s
// `CORBITS_VOCABULARY`) — the brand-correctness guidance applies here
// exactly as it did in the OG.
//
// (5) Intake: the OG parks on `awaitSignal("intake")` so a human stepper
// can fill topic/focus after the run starts. Workbench collects those
// fields on the routine *before* launch and delivers them as the
// first-turn mail (`renderRoutineInput` → `trigger.payload`). A gate
// that nobody fulfills hangs the run forever. There is no second
// intake path: the triggering mail *is* the topic/focus. Every
// reasoning step that needs them reads `{ from: "trigger.payload" }`.
//
// ## What of the prior (CL-5997) single-step port is kept vs. replaced
//
// Replaced: the single reasoning step and its monolithic system prompt
// (`LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT`) are gone, split into the
// six-step pipeline below with `./prompts.ts` holding each step's prompt.
//
// Kept: `finalize-tool.ts` and `artifact-client.ts`, unchanged. The OG's
// `persist` step dispatched a native `write_artifact` action tool with NO
// human approval; this repo has no such tool package, AND this repo's own
// ground rule ("every external side effect sits behind human approval",
// `AGENTS.md`) means an unapproved persist would be a policy regression
// even if a native action path existed here. `finalize-tool.ts`'s
// `last_30_days_research_finalize` (`approval: "ask"`) is this
// deployment's only way to reach the Library engine from a workflow tool
// package (`createWorkflowArtifact`, proven by `pain-point-collateral`/
// `collateral-generation`, CL-6000) and is exactly the shape
// `packages/chat/src/artifact-delivery.ts` already recognizes — so it
// stays, called once by the final `write` step exactly as the prior port
// called it, closing the delivery loop the same way.
//
// ## Delivery
//
// The `write` step is the run's last step; its own reply (after its one
// finalize tool call resolves) is the turn output the platform delivers
// through the run's normal mail-reply path — the same delivery every
// other single-step workflow in this catalog already uses, unchanged by
// this port going multi-step. No separate "document"/"persist" step is
// needed for delivery: the writer's own tool-calling turn IS the
// finalize + reply step, matching the prior port's delivery contract.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.

import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type {
  Selector,
  StepPrimitive,
  WorkflowDefinition,
} from "@intx/workflow";

import {
  buildCurateSystemPrompt,
  buildEntityExtractSystemPrompt,
  buildGroundingSystemPrompt,
  buildWriterSystemPrompt,
  CORBITS_VOCABULARY,
} from "./prompts";
import { LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME } from "./finalize-tool";

export const LAST_30_DAYS_RESEARCH_WORKFLOW_ID = "wf_last_30_days_research";

// Step ids, in run order. Exported so tests and any future delivery-card
// renderer can address a specific step without hardcoding string literals.
export const LAST_30_DAYS_RESEARCH_STEP_IDS = [
  "ground",
  "gather",
  "entities",
  "gather2",
  "curate",
  "write",
] as const;

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

// The heavier writer-tier preference the curate/write steps prepend ahead
// of the caller's own preferences (see adaptation (2) above). Named
// constants, not inlined, so a test can assert on them directly.
export const WRITER_MODEL_PROVIDER = "anthropic";
export const WRITER_MODEL_ID = "claude-sonnet-5";
export const WRITER_INFERENCE_PREFERENCE: InferencePreference = {
  provider: WRITER_MODEL_PROVIDER,
  model: WRITER_MODEL_ID,
};

function writerPreferences(
  fallback: readonly InferencePreference[],
): InferencePreference[] {
  return [WRITER_INFERENCE_PREFERENCE, ...fallback];
}

const GROUNDING_PROMPT = [
  CORBITS_VOCABULARY,
  buildGroundingSystemPrompt(),
].join("\n\n");
const ENTITY_EXTRACT_PROMPT = [
  CORBITS_VOCABULARY,
  buildEntityExtractSystemPrompt(),
].join("\n\n");
const CURATE_PROMPT = [CORBITS_VOCABULARY, buildCurateSystemPrompt()].join(
  "\n\n",
);

const GATHER_PROMPT = [
  CORBITS_VOCABULARY,
  "You gather last-30-days research results for a topic using whichever tools are available.",
  "Input: a topic, an optional focus, and (in later rounds) a JSON object naming a tailored query per platform — { web, github }. If no tailored query is given for a platform, fall back to the topic (narrowed by focus, if given).",
  "Call web_search and github_activity (when available), each at most once, with that platform's query. A tool call that comes back as an error (missing credential, rate limit, failed request) means that source is not reachable right now — note it plainly and move on. Never fail because one source is unavailable, and never invent results for a source you could not reach.",
  `${LAST_30_DAYS_RESEARCH_PENDING_SOURCES.join(", ")} have no workbench integration yet: always name them as "not yet connected" rather than a real result set — never fabricate discussion, launches, or activity for them.`,
  "Reply with the raw results you gathered (or your honest per-source unreachable/not-connected notes) as plain text — the next step reasons over this directly; do not summarize or drop detail.",
].join("\n\n");

const WRITE_PROMPT = [
  CORBITS_VOCABULARY,
  buildWriterSystemPrompt(LAST_30_DAYS_RESEARCH_SECTIONS),
  `Finalizing: once you have written the report, call \`${LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME}\` exactly once with outcome "report", a short title (e.g. "Last 30 days: <topic>"), and the full markdown report as content. This call requires a human's approval before it completes. Always finalize, even when the brief has no themes at all: in that case, still call \`${LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME}\` once with outcome "status-note", a teaching title (e.g. "Last 30 days: <topic> — no results yet"), and content that honestly explains what was searched for, names the missing or unreachable connectors by id (\`exa\` for web search), and says what to do next. Never end a run without finalizing — a plain reply with no artifact is not an acceptable outcome, even on the no-data path.`,
  "If the finalize call succeeds, present the finalized report as your reply exactly as written, with no commentary about the approval mechanism itself. If the call is denied, reply with one calm, plain sentence that the report was not approved and no action was taken; never present a denial as an error, and never apologize as if something broke.",
].join("\n\n");

function reasoningStep(opts: {
  id: string;
  systemPrompt: string;
  input: Selector;
  after: readonly string[];
  timeoutMs: number;
  inferencePreferences: readonly InferencePreference[];
}): StepPrimitive {
  return step({
    agent: defineAgent({
      id: opts.id,
      description: `Reasoning step: ${opts.id}`,
      systemPrompt: opts.systemPrompt,
      tools: [],
      capabilities: [],
      inference: { sources: opts.inferencePreferences },
    }),
    input: opts.input,
    after: opts.after,
    timeout: opts.timeoutMs,
  });
}

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a human messages with a topic to start a run —
 * so a definition built here is per-deployment by construction.
 */
export interface Last30DaysResearchWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. Used
   * as-is on the grounding/gathering/entity steps, and appended after
   * `WRITER_INFERENCE_PREFERENCE` on the curate/write steps. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on every step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the last-30-days-research definition: a six-step pipeline
 * whose first-turn mail *is* the topic/focus (see this file's header
 * comment for the full step-by-step account and every adaptation from
 * the OG). Tools are never inlined on the definition: they arrive as
 * packages on the deploy (`@corbits/web-search-tools`,
 * `@corbits/github-tools`), keeping the definition pure data — matching
 * every other definition in this catalog.
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

  const defaultPreferences = input.inferencePreferences;
  const writerPreferencesForStep = writerPreferences(defaultPreferences);

  return defineWorkflow({
    id: LAST_30_DAYS_RESEARCH_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      ground: reasoningStep({
        id: "last-30-days-research-ground",
        systemPrompt: GROUNDING_PROMPT,
        input: { from: "trigger.payload" },
        after: [],
        timeoutMs: input.turnTimeoutMs,
        inferencePreferences: defaultPreferences,
      }),

      gather: reasoningStep({
        id: "last-30-days-research-gather",
        systemPrompt: GATHER_PROMPT,
        input: {
          merge: [{ from: "trigger.payload" }, { from: "steps.ground.output" }],
        },
        after: ["ground"],
        timeoutMs: input.turnTimeoutMs,
        inferencePreferences: defaultPreferences,
      }),

      entities: reasoningStep({
        id: "last-30-days-research-entities",
        systemPrompt: ENTITY_EXTRACT_PROMPT,
        input: {
          merge: [{ from: "trigger.payload" }, { from: "steps.gather.output" }],
        },
        after: ["gather"],
        timeoutMs: input.turnTimeoutMs,
        inferencePreferences: defaultPreferences,
      }),

      gather2: reasoningStep({
        id: "last-30-days-research-gather2",
        systemPrompt: GATHER_PROMPT,
        input: {
          merge: [
            { from: "trigger.payload" },
            { from: "steps.entities.output" },
          ],
        },
        after: ["entities"],
        timeoutMs: input.turnTimeoutMs,
        inferencePreferences: defaultPreferences,
      }),

      curate: reasoningStep({
        id: "last-30-days-research-curate",
        systemPrompt: CURATE_PROMPT,
        input: {
          merge: [
            { from: "trigger.payload" },
            { from: "steps.gather.output" },
            { from: "steps.gather2.output" },
          ],
        },
        after: ["gather2"],
        timeoutMs: input.turnTimeoutMs,
        inferencePreferences: writerPreferencesForStep,
      }),

      write: reasoningStep({
        id: "last-30-days-research-write",
        systemPrompt: WRITE_PROMPT,
        input: {
          merge: [{ from: "trigger.payload" }, { from: "steps.curate.output" }],
        },
        after: ["curate"],
        timeoutMs: input.turnTimeoutMs,
        inferencePreferences: writerPreferencesForStep,
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
