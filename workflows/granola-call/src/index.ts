import { action, defineWorkflow } from "@intx/workflow";
import { canonicalizeStepToolName } from "@workbench/agents";

export const label = "Granola Call Processing";
export const description =
  "Automatic Granola call processing: on every run, discover recent calls and start one process-granola-call run per call that has no call-notes artifact yet. Bounded by limit (default 10). Idempotent — already-processed calls are skipped, so a quiet run spawns nothing.";
export const kind = "granola-call";

export { DISPLAY_STEPS } from "./display-steps";

// Native `action` handler refs — the tool's canonical (factory-prefixed)
// name, resolved via `canonicalizeStepToolName`'s build-time-checked
// lookup, so a typo'd or manifest-drifted tool name fails the build instead
// of deploying a step nothing can dispatch.
export const GRANOLA_LIST_NOTES_HANDLER = canonicalizeStepToolName(
  "granola-call-discover",
  "granola_list_notes",
);
export const GRANOLA_SPAWN_CALL_RUNS_HANDLER = canonicalizeStepToolName(
  "granola-call-spawn",
  "granola_spawn_call_runs",
);

/**
 * Schedule/Routine intake field. This is the ENTIRE intake surface — no note
 * id, no channel. A run started with no inputs at all must work:
 * `granola_list_notes`'s own `limit` default (10) applies whenever `limit`
 * is absent, and the spawn tool applies the same default independently.
 *
 * Named `limit` (not `maxCalls`): both action steps below pass
 * `trigger.payload` straight through as tool arguments — no argMap, no
 * per-step rename — so the ONE intake field name must already equal the
 * argument name each tool expects. `granola_list_notes` calls it `limit`;
 * `granola_spawn_call_runs` was renamed to match (see
 * `packages/tools-granola/src/hub-tools.ts`) rather than the reverse,
 * because `granola_list_notes` is a shared tool called by several other
 * agents/workflows under its existing `limit` name, while
 * `granola_spawn_call_runs` has exactly one caller (this workflow).
 */
export const INTAKE_FIELDS = [
  {
    name: "limit",
    label: "Max calls per run",
    inputHint: "text" as const,
    required: false,
    help: "How many recent Granola calls to look at each run (a number). Defaults to 10.",
    placeholder: "10",
    order: 0,
  },
] as const;

// -------------------------------------------------------------------------
// Fan-out parent: every step is a native `action` — a deterministic host
// effect with no LLM in front of it. `discover` lists recent calls; `spawn`
// (granola_spawn_call_runs, a hub tool) parses the list in plain TypeScript,
// skips notes that already have a call-notes artifact (sourceRef
// granola-call-note-<id>), and starts one process-granola-call run per new
// note through the shared run starter. Per-call processing — transcript
// fetch, extraction, verification, artifacts — lives entirely in the
// process-granola-call child workflow, each call visible as its own run.
//
// Neither step declares an `input` reshape: native selectors (`from` /
// `project` / `merge` / `literal`) can select and combine fields but cannot
// rename one, so shaping happens at the source instead —
// `trigger.payload`'s field names already equal the argument names each
// tool reads, and `steps.discover.output` (a stringTool's `{ content:
// "<json>" }` ToolResult envelope) already has the exact key
// (`content`) `granola_spawn_call_runs` expects, since that tool parses
// the JSON itself. `merge` only needs to combine the two objects, not
// transform either one.
//
// Iteration lives in the hub tool because an action step calls one tool
// once and native selectors cannot parse the list tool's JSON-string output
// into an array (`map`/`loop` cannot fan out over it); the tool is where
// "for each note" is plain code.
// -------------------------------------------------------------------------

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    discover: action({
      handler: GRANOLA_LIST_NOTES_HANDLER,
      // Every granola_list_notes arg is optional (including limit, which
      // defaults to 10 tool-side when absent) — a run started with no
      // inputs at all just works. Passed verbatim: the tool's arktype
      // schema ignores keys it does not declare, so any other trigger
      // field rides along harmlessly.
      input: { from: "trigger.payload" },
      effect: { requires: [GRANOLA_LIST_NOTES_HANDLER] },
    }),

    spawn: action({
      handler: GRANOLA_SPAWN_CALL_RUNS_HANDLER,
      // discover's output supplies `content` (the raw ToolResult);
      // trigger.payload supplies the optional `limit` cap. Later entries in
      // `merge` win on overlap — trigger.payload has no `content` key, so
      // there is none here.
      input: {
        merge: [{ from: "steps.discover.output" }, { from: "trigger.payload" }],
      },
      effect: { requires: [GRANOLA_SPAWN_CALL_RUNS_HANDLER] },
      after: ["discover"],
    }),
  },
});
