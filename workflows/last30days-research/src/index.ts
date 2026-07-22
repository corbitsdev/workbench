import { awaitSignal, defineWorkflow } from "@intx/workflow";
import type { StepPrimitive } from "@intx/workflow";
import {
  deterministicToolStep,
  inlineInferenceStep,
  LLM_WRITER_MODEL,
} from "@workbench/agents";
import {
  buildCurateSystemPrompt,
  buildEntityExtractSystemPrompt,
  buildGroundingSystemPrompt,
  buildWriterSystemPrompt,
} from "./prompts";

// The writer's output-token ceiling. The synthesis turn produces a long-form,
// multi-section report; without an explicit ceiling it ran on the kimi writer
// source's small/unset `defaults.maxTokens` and truncated mid-sentence with a
// clean `finish_reason:"length"` (no error). 16384 is comfortably above the
// longest report the brief warrants; if the model caps lower internally that is
// harmless — requesting the higher ceiling only removes our truncation.
const WRITER_MAX_TOKENS = 16384;

// The curate step emits a structured JSON brief (named themes + verbatim quotes
// + the item urls each theme cites). A full pool can produce a large object; this
// ceiling keeps the JSON from truncating mid-array (a clean finish_reason:"length"
// that would invalidate the JSON and force the deterministic fallback).
const CURATE_MAX_TOKENS = 8192;

export const label = "Last30Days Research Report";
export const description =
  "Research the last 30 days of market and community signal, synthesize a cited brief, and save it as an artifact.";
export const kind = "last30days-research";

// Re-export the user-facing display flow so it travels with the workflow package
// for the server catalog classifier; the client panel imports it from the same
// browser-safe module.
export { DISPLAY_STEPS } from "./display-steps";

// The first-intake form descriptor (CL-3509 / CL-3860): schedule field metadata
// the attach UI and Automations form collect so a scheduled run's `intake` gate
// is pre-filled and auto-delivered without a human. Mirrors the intake form
// (topic required, focus optional); payload validates against
// Last30daysIntakePayloadSchema at the /resume boundary.
export const INTAKE_FIELDS = [
  {
    kind: "text",
    inputHint: "text",
    name: "topic",
    label: "Topic",
    placeholder: "e.g. AI coding agents for GTM teams",
    required: true,
    help: "What should each scheduled run research?",
    order: 0,
  },
  {
    kind: "textarea",
    inputHint: "textarea",
    name: "focus",
    label: "Focus (optional)",
    placeholder: "Narrow the query or angle",
    help: "Optional angle or constraints for the brief.",
    order: 1,
  },
] as const;

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
  title: string;
}) {
  return deterministicToolStep({
    id: opts.id,
    tool: opts.tool,
    title: opts.title,
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
// Web news is the SPINE of the brief: for a launch/release/announcement topic the
// coverage IS the story, and Reddit/X/YouTube are supporting community VOICE, not
// the headline. So web pulls the deepest pool and the engagement sources are
// capped well below it — otherwise a flood of pure-complaint or "which is best?"
// Reddit threads outnumbers the launch news and the curate pool skews to
// off-intent chatter (the recall failure CL-2503 fixes).
// Three complementary web queries (web/webB/webC) form the spine: a semantic news
// engine returns a different slice of real launches per phrasing, and no single
// query covers the field — their UNION does. Each pulls Exa's max (25). The
// engagement sources are capped well below the web pool so launch news dominates
// the curate pool over community chatter.
const SOURCES = [
  { key: "web", tool: "exa_search", limit: 25, title: "Search the web" },
  { key: "webB", tool: "exa_search", limit: 25, title: "Search the web again" },
  {
    key: "webC",
    tool: "exa_search",
    limit: 25,
    title: "Search the web once more",
  },
  {
    key: "hackernews",
    tool: "hackernews_search",
    limit: 20,
    title: "Search Hacker News",
  },
  {
    key: "github",
    tool: "github_activity",
    limit: 15,
    title: "Scan GitHub activity",
  },
  { key: "reddit", tool: "reddit_search", limit: 20, title: "Search Reddit" },
  { key: "x", tool: "x_search", limit: 15, title: "Search X" },
  {
    key: "youtube",
    tool: "youtube_search",
    limit: 12,
    title: "Search YouTube",
  },
  {
    key: "polymarket",
    tool: "polymarket_odds",
    limit: 15,
    title: "Check Polymarket odds",
  },
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
      title: source.title,
    });
    previous = source.key;
  }
  return steps;
}

// Round-2 entity-chasing fan-out (CL-2503): re-query the engagement-rich
// platforms with the entity-focused queries the `entities` step produced, so the
// launches discovered in round 1 get deeper coverage and community reaction
// (Larry's entity-chasing). Each source pulls its query from the entity-queries
// map (`steps.entityQueries.output.content.<mapKey>`); the parse tool guarantees
// each key is a non-empty string (base-query fallback). Serial like round 1
// (the CL-2314 single-writer constraint): chained off `firstAfter` and each
// predecessor, and starting only after the entire round-1 chain has drained.
const entityQueriesInput = {
  from: "steps.entityQueries.output.content",
} as const;

const ROUND2_SOURCES = [
  {
    id: "web2",
    tool: "exa_search",
    mapKey: "web",
    limit: 30,
    title: "Dig deeper on the web",
  },
  {
    id: "reddit2",
    tool: "reddit_search",
    mapKey: "reddit",
    limit: 18,
    title: "Dig deeper on Reddit",
  },
  {
    id: "x2",
    tool: "x_search",
    mapKey: "x",
    limit: 15,
    title: "Dig deeper on X",
  },
  {
    id: "youtube2",
    tool: "youtube_search",
    mapKey: "youtube",
    limit: 12,
    title: "Dig deeper on YouTube",
  },
] as const;

const lastRound2 = ROUND2_SOURCES.at(-1);
if (lastRound2 === undefined) {
  throw new Error(
    "last30days workflow: ROUND2_SOURCES must declare at least one source",
  );
}
const LAST_ROUND2_ID = lastRound2.id;

function buildEntityRoundSteps(
  firstAfter: string,
): Record<string, StepPrimitive> {
  const steps: Record<string, StepPrimitive> = {};
  let previous = firstAfter;
  for (const source of ROUND2_SOURCES) {
    steps[source.id] = deterministicToolStep({
      id: `last30days-fetch-${source.id}`,
      tool: source.tool,
      title: source.title,
      input: entityQueriesInput,
      argMap: {
        query: { from: source.mapKey },
        limit: { literal: source.limit },
      },
      after: [previous],
      nonFatal: true,
    });
    previous = source.id;
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
      title: "Ground the topic",
      systemPrompt: buildGroundingSystemPrompt(),
      input: { from: "steps.intake.output" },
      after: ["intake"],
    }),

    // Parse the grounding reply into a per-source query map addressable by field
    // (`steps.groundQueries.output.content.<source>`). Returns object content so
    // each source step can select its own query.
    groundQueries: deterministicToolStep({
      id: "last30days-ground-queries",
      title: "Draft per-source queries",
      tool: "last30days_ground_queries",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.ground.output" },
        ],
      },
      after: ["ground"],
    }),

    // Round-1 source fan-out (serial, see SOURCES + the CL-2314 note above). The
    // first source depends on groundQueries; the rest chain off their predecessor.
    ...buildSourceSteps("groundQueries"),

    // Genuine-reasoning entity extraction (CL-2503): reads the round-1 results and
    // names the concrete launches/entities that surfaced, emitting an entity-focused
    // follow-up query per platform so round 2 chases them deeper. Best-effort — the
    // parse tool falls back to the base query if the reply is malformed.
    entities: inlineInferenceStep({
      id: "last30days-entities",
      title: "Extract key entities",
      systemPrompt: buildEntityExtractSystemPrompt(),
      input: { from: "steps" },
      after: [LAST_SOURCE_KEY],
    }),

    // Parse the entity reply into a round-2 per-source query map addressable by
    // field (`steps.entityQueries.output.content.<source>`).
    entityQueries: deterministicToolStep({
      id: "last30days-entity-queries",
      title: "Draft entity queries",
      tool: "last30days_entity_queries",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.entities.output" },
        ],
      },
      after: ["entities"],
    }),

    // Round-2 entity-chasing fan-out (serial). Starts only after the round-1
    // chain has fully drained (entities/entityQueries depend on LAST_SOURCE_KEY),
    // so no two source bodies are in flight (CL-2314).
    ...buildEntityRoundSteps("entityQueries"),

    // Collect both rounds into one clean candidate pool (date-filtered, deduped,
    // structural-junk-filtered) for the curate step to judge.
    collect: deterministicToolStep({
      id: "last30days-collect",
      title: "Collect & dedupe results",
      tool: "last30days_collect",
      input: { from: "steps" },
      after: [LAST_ROUND2_ID],
    }),

    // Genuine-reasoning curation (CL-2503): the judgment the deterministic
    // cluster/filter pipeline cannot do — drop promo/shill/off-topic, group the
    // survivors into 3-6 named themes, and select 3-5 verbatim community quotes.
    // Runs on the heavier writer model. Best-effort — the brief tool falls back to
    // the deterministic buildReport pipeline if the curate JSON is missing or junk.
    curate: inlineInferenceStep({
      id: "last30days-curate",
      title: "Curate themes & quotes",
      systemPrompt: buildCurateSystemPrompt(),
      model: LLM_WRITER_MODEL,
      maxTokens: CURATE_MAX_TOKENS,
      input: { from: "steps.collect.output.content" },
      after: ["collect"],
    }),

    // Assemble the structured brief: from the curate JSON when usable, else the
    // deterministic fallback over the collected pool.
    brief: deterministicToolStep({
      id: "last30days-build-brief",
      title: "Assemble the brief",
      tool: "last30days_workflow_brief",
      input: { from: "steps" },
      after: ["curate"],
    }),

    // The synthesis turn runs on a heavier model (LLM_WRITER_MODEL) than the
    // research/grounding steps: long-form, grounded report writing benefits from
    // the deeper model, while grounding/rerank stay on the fast default. Falls
    // back to the default when the tenant catalog does not carry the writer model
    // (resolveWorkflowDeploySource resolves it optionally).
    write: inlineInferenceStep({
      id: "last30days-write-report",
      title: "Write the report",
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
      title: "Save the research artifact",
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
