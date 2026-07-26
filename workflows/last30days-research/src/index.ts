import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import type { Primitive } from "@intx/workflow";
import {
  agentStep,
  canonicalizeStepToolName,
  LLM_WRITER_MODEL,
} from "@workbench/agents";
import { INTAKE_SIGNAL, STEP_UI } from "./step-ui";
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
// the attach UI and Routines form collect so a scheduled run's `intake` gate
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

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via `canonicalizeStepToolName`'s build-time-checked lookup, so
// a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch. Each of these steps is fatal-only
// (no best-effort degrade needed) and its `argMap` was always an identity
// passthrough or a literal, so a plain `action` + native selector expresses it
// exactly with no reshape step in between.
export const GROUND_QUERIES_HANDLER = canonicalizeStepToolName(
  "last30days-ground-queries",
  "last30days_ground_queries",
);
export const ENTITY_QUERIES_HANDLER = canonicalizeStepToolName(
  "last30days-entity-queries",
  "last30days_entity_queries",
);
export const COLLECT_HANDLER = canonicalizeStepToolName(
  "last30days-collect",
  "last30days_collect",
);
export const WORKFLOW_BRIEF_HANDLER = canonicalizeStepToolName(
  "last30days-build-brief",
  "last30days_workflow_brief",
);
export const FORMAT_REPORT_DOCUMENT_HANDLER = canonicalizeStepToolName(
  "last30days-document",
  "last30days_format_report_document",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "last30days-persist-artifact",
  "write_artifact",
);

// The workflow's own "safe" source-tool wrappers: one per distinct
// underlying source tool, each calling the real tool's handler in-process and
// degrading a thrown error to a `{ isError: true, error }` JSON envelope
// instead of propagating (see `./tools.ts`). This is what lets every source
// step below become a plain native `action` — no `nonFatal` dispatch tag is
// needed because the wrapper's own `ToolResult.isError` never comes back
// true, so `runDeterministicToolStep` never throws for it.
export const SAFE_EXA_SEARCH_HANDLER = canonicalizeStepToolName(
  "last30days-fetch-exa",
  "last30days_safe_exa_search",
);
export const SAFE_HACKERNEWS_SEARCH_HANDLER = canonicalizeStepToolName(
  "last30days-fetch-hackernews",
  "last30days_safe_hackernews_search",
);
export const SAFE_GITHUB_ACTIVITY_HANDLER = canonicalizeStepToolName(
  "last30days-fetch-github",
  "last30days_safe_github_activity",
);
export const SAFE_REDDIT_SEARCH_HANDLER = canonicalizeStepToolName(
  "last30days-fetch-reddit",
  "last30days_safe_reddit_search",
);
export const SAFE_X_SEARCH_HANDLER = canonicalizeStepToolName(
  "last30days-fetch-x",
  "last30days_safe_x_search",
);
export const SAFE_YOUTUBE_SEARCH_HANDLER = canonicalizeStepToolName(
  "last30days-fetch-youtube",
  "last30days_safe_youtube_search",
);
export const SAFE_POLYMARKET_ODDS_HANDLER = canonicalizeStepToolName(
  "last30days-fetch-polymarket",
  "last30days_safe_polymarket_odds",
);

// Maps each source's original (unwrapped) tool name to its safe wrapper's
// canonical handler ref, so `sourceStep`/`buildEntityRoundSteps` below share
// one lookup instead of a per-source if/else.
const SAFE_SOURCE_HANDLERS: Record<string, string> = {
  exa_search: SAFE_EXA_SEARCH_HANDLER,
  hackernews_search: SAFE_HACKERNEWS_SEARCH_HANDLER,
  github_activity: SAFE_GITHUB_ACTIVITY_HANDLER,
  reddit_search: SAFE_REDDIT_SEARCH_HANDLER,
  x_search: SAFE_X_SEARCH_HANDLER,
  youtube_search: SAFE_YOUTUBE_SEARCH_HANDLER,
  polymarket_odds: SAFE_POLYMARKET_ODDS_HANDLER,
};

function safeSourceHandler(tool: string): string {
  const handler = SAFE_SOURCE_HANDLERS[tool];
  if (handler === undefined) {
    throw new Error(
      `last30days workflow: no safe wrapper handler registered for source tool "${tool}"`,
    );
  }
  return handler;
}

// The real underlying tool's own canonical name, per source. Every wrapped
// action step declares BOTH its safe handler AND this sibling name in
// `effect.requires` — not to ever dispatch it (the wrapper calls the real
// tool's handler in-process, never through the runtime's own dispatch), but
// so the deploy's capability walk also pins the sibling package (e.g.
// `@workbench/tools-exa`). That sibling's OWN manifest legitimately declares
// the credential provider (`exa`/`github`/`scrapecreators`/`xai`/`youtube`)
// this workflow's wrapper package's manifest cannot claim for itself (see the
// `providerName: null` note in `./tool-manifest.ts`) — pinning it is what
// puts the provider into the step's credential-route allow-list. Keyless
// sources (hackernews/polymarket) need no sibling pin.
const UNDERLYING_SOURCE_TOOL_HANDLERS: Record<string, string> = {
  exa_search: canonicalizeStepToolName("last30days-fetch-exa", "exa_search"),
  github_activity: canonicalizeStepToolName(
    "last30days-fetch-github",
    "github_activity",
  ),
  reddit_search: canonicalizeStepToolName(
    "last30days-fetch-reddit",
    "reddit_search",
  ),
  x_search: canonicalizeStepToolName("last30days-fetch-x", "x_search"),
  youtube_search: canonicalizeStepToolName(
    "last30days-fetch-youtube",
    "youtube_search",
  ),
};

function sourceEffectRequires(tool: string, handler: string): string[] {
  const sibling = UNDERLYING_SOURCE_TOOL_HANDLERS[tool];
  return sibling === undefined ? [handler] : [handler, sibling];
}

// Each source pulls its query from the grounding step's per-source map rather
// than the raw topic, so e.g. github_activity gets repo/org names and
// youtube_search gets video-title phrasing instead of all sources searching the
// same string. `last30days_ground_queries` guarantees every key is a non-empty
// string (falling back to the base query) nested under `{ query }` (CL-4232),
// so a plain per-source path selector already yields the tool's own argument
// name — no per-source rename.
function groundedQueryInput(sourceKey: string) {
  return { from: `steps.groundQueries.output.content.${sourceKey}` } as const;
}

// A source fetch is best-effort: a dead search API (rate-limit/auth/network)
// must degrade to a recorded skip in the brief, never fail the run. Formerly
// this ran as a `deterministicToolStep` carrying the `nonFatal` dispatch tag,
// because the native `action` primitive has no error-swallow of its own (a
// thrown tool error inside an action's `ctx.perform` always propagates and
// fails the run — see `apps/sidecar/src/action-tool-handler.ts`). The
// tolerance moves INSIDE a tool this workflow owns instead: each source
// dispatches its own `last30days_safe_*` wrapper (`./tools.ts`), which calls
// the real source tool in-process and turns a thrown error into a
// successful result carrying a `{ isError: true, error }` JSON body, so the
// wrapped step is a plain native `action` and never needs `nonFatal`. The
// `argMap` shim is still gone: `input` composes the tool's exact args
// directly via `merge`+`literal` (the per-source path selector already
// yields `{ query }`, the tool's own argument name — see
// `groundedQueryInput`/`entityQueryInput`), so there is no separate reshape
// step left to drift from the evaluated input.
function sourceStep(opts: {
  id: string;
  tool: string;
  sourceKey: string;
  limit: number;
  after: readonly string[];
  title: string;
}) {
  const handler = safeSourceHandler(opts.tool);
  return action({
    handler,
    input: {
      merge: [
        groundedQueryInput(opts.sourceKey),
        { literal: { limit: opts.limit } },
      ],
    },
    effect: { requires: sourceEffectRequires(opts.tool, handler) },
    after: opts.after,
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
function buildSourceSteps(firstAfter: string): Record<string, Primitive> {
  const steps: Record<string, Primitive> = {};
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
function entityQueryInput(mapKey: string) {
  return { from: `steps.entityQueries.output.content.${mapKey}` } as const;
}

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

function buildEntityRoundSteps(firstAfter: string): Record<string, Primitive> {
  const steps: Record<string, Primitive> = {};
  let previous = firstAfter;
  for (const source of ROUND2_SOURCES) {
    const handler = safeSourceHandler(source.tool);
    steps[source.id] = action({
      handler,
      input: {
        merge: [
          entityQueryInput(source.mapKey),
          { literal: { limit: source.limit } },
        ],
      },
      effect: { requires: sourceEffectRequires(source.tool, handler) },
      after: [previous],
    });
    previous = source.id;
  }
  return steps;
}

// Shared research substrate for workflows that need a current, grounded story.
// It intentionally stops at `brief`: callers own their final artifact-writing step.
export function buildResearchSteps(): Record<string, Primitive> {
  return {
    // Genuine-reasoning grounding (W1.1): turns the topic + focus into one search
    // query tailored to each platform. Robust to a degraded or malformed grounding
    // REPLY — `groundQueries` backfills any missing/blank source with the
    // untailored base query. It is NOT, however, best-effort against an inference
    // OUTAGE: like `rerank`/`write`, an inline step cannot carry `nonFatal`, so a
    // failed grounding turn fails the run (a one-call dependency, same as those).
    ground: agentStep({
      id: "last30days-ground",
      title: "Ground the topic",
      systemPrompt: buildGroundingSystemPrompt(),
      input: { from: "steps.intake.output" },
      after: ["intake"],
    }),

    // Parse the grounding reply into a per-source query map addressable by
    // field (`steps.groundQueries.output.content.<source>`). Native `action`:
    // fatal-only (a malformed reply still degrades gracefully inside the tool;
    // a THROWN tool error here — e.g. a bad merged input shape — should fail
    // the run), and the tool's `additionalProperties: true` schema already
    // reads straight off the merged `{ topic, focus, reply }` input with no
    // reshape, so there was never an argMap to carry forward.
    groundQueries: action({
      handler: GROUND_QUERIES_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.ground.output" },
        ],
      },
      effect: { requires: [GROUND_QUERIES_HANDLER] },
      after: ["ground"],
    }),

    // Round-1 source fan-out (serial, see SOURCES + the CL-2314 note above). The
    // first source depends on groundQueries; the rest chain off their predecessor.
    ...buildSourceSteps("groundQueries"),

    // Genuine-reasoning entity extraction (CL-2503): reads the round-1 results and
    // names the concrete launches/entities that surfaced, emitting an entity-focused
    // follow-up query per platform so round 2 chases them deeper. Best-effort — the
    // parse tool falls back to the base query if the reply is malformed.
    entities: agentStep({
      id: "last30days-entities",
      title: "Extract key entities",
      systemPrompt: buildEntityExtractSystemPrompt(),
      input: { from: "steps" },
      after: [LAST_SOURCE_KEY],
    }),

    // Parse the entity reply into a round-2 per-source query map addressable by
    // field (`steps.entityQueries.output.content.<source>`). Native `action`,
    // same reasoning as `groundQueries`.
    entityQueries: action({
      handler: ENTITY_QUERIES_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.entities.output" },
        ],
      },
      effect: { requires: [ENTITY_QUERIES_HANDLER] },
      after: ["entities"],
    }),

    // Round-2 entity-chasing fan-out (serial). Starts only after the round-1
    // chain has fully drained (entities/entityQueries depend on LAST_SOURCE_KEY),
    // so no two source bodies are in flight (CL-2314).
    ...buildEntityRoundSteps("entityQueries"),

    // Collect both rounds into one clean candidate pool (date-filtered, deduped,
    // structural-junk-filtered) for the curate step to judge. Native `action`:
    // the tool reads the whole `steps` map itself (`additionalProperties: true`),
    // so `input: { from: "steps" }` was already the entire call, argMap-free.
    collect: action({
      handler: COLLECT_HANDLER,
      input: { from: "steps" },
      effect: { requires: [COLLECT_HANDLER] },
      after: [LAST_ROUND2_ID],
    }),

    // Genuine-reasoning curation (CL-2503): the judgment the deterministic
    // cluster/filter pipeline cannot do — drop promo/shill/off-topic, group the
    // survivors into 3-6 named themes, and select 3-5 verbatim community quotes.
    // Runs on the heavier writer model. Best-effort — the brief tool falls back to
    // the deterministic buildReport pipeline if the curate JSON is missing or junk.
    curate: agentStep({
      id: "last30days-curate",
      title: "Curate themes & quotes",
      systemPrompt: buildCurateSystemPrompt(),
      model: LLM_WRITER_MODEL,
      maxTokens: CURATE_MAX_TOKENS,
      input: { from: "steps.collect.output.content" },
      after: ["collect"],
    }),

    // Assemble the structured brief: from the curate JSON when usable, else the
    // deterministic fallback over the collected pool. Native `action`, same
    // whole-`steps`-map read as `collect`.
    brief: action({
      handler: WORKFLOW_BRIEF_HANDLER,
      input: { from: "steps" },
      effect: { requires: [WORKFLOW_BRIEF_HANDLER] },
      after: ["curate"],
    }),
  };
}

// Re-exported so server-side consumers of the main entry (the workflow
// catalog, the pipeline) keep working unchanged. Browser consumers must
// import these from the `./browser` subpath instead (see package.json
// exports) — importing this main entry pulls in `defineWorkflow` and
// `@workbench/agents`, both of which construct agents at module load time
// and crash in the browser.
export { INTAKE_SIGNAL, STEP_UI };

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    intake: awaitSignal({ name: INTAKE_SIGNAL }),
    ...buildResearchSteps(),

    write: agentStep({
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

    // Pairs the intake topic with the writer agent's reply into { title, body }
    // (CL-4232) — the one place the agent's `reply` output field is read, so
    // persist never reshapes it. Native `action`: the tool reads `topic`/`reply`
    // straight off the merged input (both already top-level, unrenamed), so
    // this never carried an argMap.
    document: action({
      handler: FORMAT_REPORT_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.write.output" },
        ],
      },
      effect: { requires: [FORMAT_REPORT_DOCUMENT_HANDLER] },
      after: ["write"],
    }),

    // Persist the artifact. Native `action`, fatal-only (a persist failure must
    // fail the run). The former `argMap` here was NOT a rename shim — every
    // field (`title`, `body`, `content`) already carried its write_artifact
    // argument name straight off the merge of `document.output.content`
    // (`{ title, body }`) and `brief.output` (`{ content: "<report JSON>" }`,
    // read by the hub's write_artifact handler to populate the artifact's rich
    // brief + citations — CL-2640 confirmed this field is load-bearing, not
    // dead). `kind`/`jobLabel` were constants. So the merge selector plus one
    // `{ literal }` for the two constants expresses the exact same call with no
    // reshape step at all.
    persist: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          { from: "steps.document.output.content" },
          { from: "steps.brief.output" },
          { literal: { kind: "research", jobLabel: "Last 30 days research" } },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["document"],
    }),
  },
});
