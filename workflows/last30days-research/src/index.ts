import { awaitSignal, defineWorkflow } from "@intx/workflow";
import type { StepPrimitive } from "@intx/workflow";
import {
  deterministicToolStep,
  inlineInferenceStep,
  LLM_WRITER_MODEL,
} from "@workbench/agents";
import {
  buildGroundingSystemPrompt,
  buildRerankSystemPrompt,
  buildWriterSystemPrompt,
} from "./prompts";

// The writer's output-token ceiling. The synthesis turn produces a long-form,
// multi-section report; without an explicit ceiling it ran on the kimi writer
// source's small/unset `defaults.maxTokens` and truncated mid-sentence with a
// clean `finish_reason:"length"` (no error). 16384 is comfortably above the
// longest report the brief warrants; if the model caps lower internally that is
// harmless — requesting the higher ceiling only removes our truncation.
const WRITER_MAX_TOKENS = 16384;

export const label = "last30days Research";
export const description =
  "Research the last 30 days of market and community signal, synthesize a cited brief, and save it as an artifact.";
export const kind = "last30days-research";

// Each source pulls its query from the grounding step's per-source map rather
// than the raw topic, so e.g. github_activity gets repo/org names and
// youtube_search gets video-title phrasing instead of all sources searching the
// same string. `last30days_ground_queries` guarantees every key is a non-empty
// string (falling back to the base query), so a thin grounding reply never
// blanks a source.
const groundedQueriesInput = {
  from: "steps.groundQueries.output.content",
} as const;

// A source fetch is best-effort: a dead search API (rate-limit/auth/network)
// must degrade to a recorded skip in the brief, never fail the run. `nonFatal`
// makes the sidecar log the reason and return an isError envelope rather than
// throwing, so the source step completes and `brief` still runs (CL-2401).
// Tradeoff: a degraded step is "completed", so the runtime's tool-step retry
// no longer fires — a transient blip degrades on first failure instead of
// being retried. Acceptable here: not killing the run dominates, and the
// chronic failures (e.g. bluesky) are permanent, not transient.
//
// `sourceKey` selects this source's tailored query off the grounded-queries map;
// `limit` raises the per-source result count off each tool's small default
// toward its cap so the candidate pool is deep enough to survive date-filtering
// and the relevance floor.
function sourceStep(opts: {
  id: string;
  tool: string;
  sourceKey: string;
  limit: number;
  after: readonly string[];
}) {
  return deterministicToolStep({
    id: opts.id,
    tool: opts.tool,
    input: groundedQueriesInput,
    argMap: {
      query: { from: opts.sourceKey },
      limit: { literal: opts.limit },
    },
    after: opts.after,
    nonFatal: true,
  });
}

// The source fetches are chained sequentially rather than fanned out in
// parallel. In the sidecar workflow-host topology the runtime body's
// per-runId commit-chain only serializes body-vs-body event commits; the
// scheduler's `TimerFired` (emitted on a tool-step retry) is a second,
// uncoordinated writer to the same run's event log. With a parallel fan-out over
// rate-limit-prone search APIs, a retry timer lands between a concurrent step's
// seq read and its append, tripping the runtime's single-writer seq guard and
// failing the whole run. A serial chain guarantees no body commit is in flight
// while a step awaits its retry timer, so the scheduler write can never race a
// body write. The data flow is unchanged (`brief` still reads every source via
// `{ from: 'steps' }`); only ordering is constrained. Revert to fan-out once the
// vendored runtime fix coordinates the scheduler with the commit-chain (CL-2314).
//
// Bluesky is disabled (CL-2401): its search API fails on every run. It stays
// out of the chain until the auth path is fixed.
//
// The fan-out sources, the single source of truth for the chain. Each entry's
// `key` is the per-source query field (must match the grounding prompt's JSON
// keys and the parse tool's GROUNDING_SOURCE_KEYS; a mismatch degrades that
// source to the untailored base query rather than erroring). `limit` deepens the
// candidate pool off each tool's small default and is at or under the tool's own
// MAX cap (which the tool clamps anyway).
const SOURCES = [
  { key: "hackernews", tool: "hackernews_search", limit: 30 },
  { key: "github", tool: "github_activity", limit: 25 },
  { key: "web", tool: "exa_search", limit: 25 },
  { key: "reddit", tool: "reddit_search", limit: 40 },
  { key: "x", tool: "x_search", limit: 20 },
  { key: "youtube", tool: "youtube_search", limit: 20 },
  { key: "polymarket", tool: "polymarket_odds", limit: 25 },
] as const;

const lastSource = SOURCES.at(-1);
if (lastSource === undefined) {
  throw new Error(
    "last30days workflow: SOURCES must declare at least one source",
  );
}
const LAST_SOURCE_KEY = lastSource.key;

// Build the serial source chain: the first source depends on `firstAfter`, each
// subsequent one on its predecessor, so no two source bodies are in flight at
// once (the CL-2314 single-writer constraint above).
function buildSourceSteps(firstAfter: string): Record<string, StepPrimitive> {
  const steps: Record<string, StepPrimitive> = {};
  let previous = firstAfter;
  for (const source of SOURCES) {
    steps[source.key] = sourceStep({
      id: `last30days-fetch-${source.key}`,
      tool: source.tool,
      sourceKey: source.key,
      limit: source.limit,
      after: [previous],
    });
    previous = source.key;
  }
  return steps;
}

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    intake: awaitSignal({ name: "intake" }),

    // Genuine-reasoning grounding (W1.1): turns the topic + focus into one search
    // query tailored to each platform. Robust to a degraded or malformed grounding
    // REPLY — `groundQueries` backfills any missing/blank source with the
    // untailored base query. It is NOT, however, best-effort against an inference
    // OUTAGE: like `rerank`/`write`, an inline step cannot carry `nonFatal`, so a
    // failed grounding turn fails the run (a one-call dependency, same as those).
    ground: inlineInferenceStep({
      id: "last30days-ground",
      systemPrompt: buildGroundingSystemPrompt(),
      input: { from: "steps.intake.output" },
      after: ["intake"],
    }),

    // Parse the grounding reply into a per-source query map addressable by field
    // (`steps.groundQueries.output.content.<source>`). Returns object content so
    // each source step can select its own query.
    groundQueries: deterministicToolStep({
      id: "last30days-ground-queries",
      tool: "last30days_ground_queries",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.ground.output" },
        ],
      },
      after: ["ground"],
    }),

    // Source fan-out (serial, see SOURCES + the CL-2314 note above). The first
    // source depends on groundQueries; the rest chain off their predecessor.
    ...buildSourceSteps("groundQueries"),

    // Genuine-reasoning relevance judge (W1.2): scores each candidate's
    // relevance to the topic. Its JSON reply feeds the brief, which applies the
    // scores before ranking. Best-effort — the brief degrades to deterministic
    // entity grounding if the judge output is missing or malformed.
    rerank: inlineInferenceStep({
      id: "last30days-rerank",
      systemPrompt: buildRerankSystemPrompt(),
      input: { from: "steps" },
      after: [LAST_SOURCE_KEY],
    }),

    brief: deterministicToolStep({
      id: "last30days-build-brief",
      tool: "last30days_workflow_brief",
      input: { from: "steps" },
      after: ["rerank"],
    }),

    // The synthesis turn runs on a heavier model (LLM_WRITER_MODEL) than the
    // research/grounding steps: long-form, grounded report writing benefits from
    // the deeper model, while grounding/rerank stay on the fast default. Falls
    // back to the default when the tenant catalog does not carry the writer model
    // (resolveWorkflowDeploySource resolves it optionally).
    write: inlineInferenceStep({
      id: "last30days-write-report",
      systemPrompt: buildWriterSystemPrompt(),
      model: LLM_WRITER_MODEL,
      maxTokens: WRITER_MAX_TOKENS,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.brief.output" },
        ],
      },
      after: ["brief"],
    }),

    persist: deterministicToolStep({
      id: "last30days-persist-artifact",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.brief.output" },
          { from: "steps.write.output" },
        ],
      },
      argMap: {
        title: { from: "topic" },
        body: { from: "reply" },
        kind: { literal: "research" },
        content: { from: "content" },
        jobLabel: { literal: "Last 30 days research" },
      },
      after: ["write"],
    }),
  },
});
